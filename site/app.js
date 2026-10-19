// Anime tracker: search AniList (through the media-search Edge Function), keep a personal
// library in anime.tracker_entries, and total up time watched.
import { supabase, requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import { STATUSES, STATUS_LABEL, fullMinutes, minutesWatched, fmtDuration } from './stats.js';
import { readExportText, parseMalExport, buildRow } from './mal-import.js';

const SLUG = 'anime';
const db = supabase.schema('anime'); // this project's tables live in the `anime` schema

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

let entries = [];
const openIds = new Set(); // entries whose advanced section is open; survives re-renders

// ---- Edge Function --------------------------------------------------------------------------

async function lookup(payload) {
  const { data, error } = await supabase.functions.invoke('media-search', { body: payload });
  if (error) {
    let detail = error.message;
    try {
      const body = await error.context.json();
      detail = body.detail || body.error || detail;
    } catch {
      // keep generic message
    }
    throw new Error(detail);
  }
  return data;
}

// ---- search ---------------------------------------------------------------------------------

const SOURCE = 'anilist';
let searchSeq = 0;
let searchTimer;
let shown = [];

function setResults(results) {
  shown = results;
  $('results').replaceChildren(...results.map(resultRow));
}

// Runs on every pause in typing; a newer search makes any older response a no-op.
async function runSearch() {
  clearTimeout(searchTimer);
  const q = $('search-q').value.trim();
  const msg = $('search-msg');
  const seq = ++searchSeq;
  if (q.length < 2) {
    shown = [];
    $('results').replaceChildren();
    msg.textContent = '';
    return;
  }
  msg.textContent = 'Searching…';
  try {
    const { results } = await lookup({ action: 'search', source: SOURCE, q });
    if (seq !== searchSeq) return;
    msg.textContent = results.length ? '' : 'No results.';
    setResults(results);
  } catch (e) {
    if (seq !== searchSeq) return;
    $('results').replaceChildren();
    msg.textContent = `Search failed: ${e.message}`;
  }
}

function queueSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 350);
}

function resultRow(r) {
  const have = entries.some((e) => e.source === r.source && e.source_id === r.source_id);
  const sub = [r.type, r.year, r.episodes ? `${r.episodes} eps` : null].filter(Boolean).join(' · ');
  const btn = el('button', { type: 'button', textContent: have ? 'In library' : 'Add', disabled: have });
  const li = el(
    'li',
    { className: have ? 'have' : '', title: r.title },
    poster(r.poster_url, r.title, 'poster'),
    el('div', { className: 'info' }, el('span', { textContent: r.title }), el('small', { textContent: sub })),
    btn,
  );
  if (!have) li.onclick = () => openAddDialog(r);
  return li;
}

function poster(url, alt, className) {
  const img = el('img', { className, alt: '', loading: 'lazy' });
  if (typeof url === 'string' && url.startsWith('https://')) img.src = url;
  else img.removeAttribute('src');
  img.title = alt;
  return img;
}

// ---- add dialog -----------------------------------------------------------------------------

function ratingSelect(value) {
  const select = el('select');
  select.append(new Option('Unrated', ''));
  for (let r = 10; r >= 0.5; r -= 0.5) select.append(new Option(r.toFixed(1), String(r), false, value === r));
  if (value == null) select.value = '';
  return select;
}

const today = () => new Date().toLocaleDateString('en-CA'); // local date as YYYY-MM-DD

// Dates to fill in when a status is chosen: starting a show stamps "started", finishing stamps "finished".
// Only empty fields are filled, so dates the user typed are never overwritten.
function datesFor(status, startedOn, finishedOn) {
  const changes = {};
  if (status === 'watching' && !startedOn) changes.started_on = today();
  if (status === 'completed' && !finishedOn) changes.finished_on = today();
  return changes;
}

const datesError = (started, finished) =>
  started && finished && finished < started ? 'The finish date is before the start date.' : null;

// Shows the chosen title and asks for status, progress, rating and notes before saving.
// The full details (episode count, studios, ...) load in the background.
function openAddDialog(r) {
  const dlg = $('add-dialog');
  let details = null;

  const msg = el('p', { className: 'muted', textContent: 'Loading details…', role: 'status' });
  const status = el('select');
  for (const [v, label] of STATUSES) status.append(new Option(label, v, false, v === 'planned'));
  const rating = ratingSelect(null);
  const watched = el('input', { type: 'number', min: 0, value: 0 });
  const watchedLabel = labeled('Episodes watched', watched);
  watchedLabel.hidden = true;
  const rewatches = el('input', { type: 'number', min: 0, value: 0 });
  const started = el('input', { type: 'date' });
  const finished = el('input', { type: 'date' });
  const notes = el('textarea', { placeholder: 'Notes', ariaLabel: `Notes for ${r.title}` });
  const save = el('button', { type: 'submit', textContent: 'Add to library', disabled: true });
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Cancel', onclick: () => dlg.close() });

  // Planned means nothing watched yet; completed means everything (when the total is known).
  const syncEpisodes = () => {
    if (!details || details.kind !== 'series') return;
    const total = details.episodes;
    if (status.value === 'planned') watched.value = 0;
    else if (status.value === 'completed' && total != null) watched.value = total;
    watched.disabled = status.value === 'planned' || (status.value === 'completed' && total != null);
  };
  status.onchange = () => {
    syncEpisodes();
    const fill = datesFor(status.value, started.value, finished.value);
    if (fill.started_on) started.value = fill.started_on;
    if (fill.finished_on) finished.value = fill.finished_on;
  };

  const sub = [r.type, r.year, r.episodes ? `${r.episodes} eps` : null].filter(Boolean).join(' · ');
  const form = el(
    'form',
    { className: 'add-form' },
    el(
      'div',
      { className: 'add-head' },
      poster(r.poster_url, r.title, 'poster'),
      el('div', {}, el('h2', { textContent: r.title }), el('p', { className: 'muted', textContent: sub })),
    ),
    el(
      'div',
      { className: 'controls' },
      labeled('Status', status),
      watchedLabel,
      labeled('Rating /10', rating),
      labeled('Rewatches', rewatches),
      labeled('Started', started),
      labeled('Finished', finished),
    ),
    notes,
    msg,
    el('div', { className: 'foot' }, cancel, save),
  );

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!details) return;
    const bad = datesError(started.value, finished.value);
    if (bad) {
      msg.textContent = bad;
      return;
    }
    save.disabled = true;
    msg.textContent = 'Saving…';
    let n = 0;
    if (details.kind === 'series') {
      n = Math.max(0, Math.floor(Number(watched.value) || 0));
      if (details.episodes != null) n = Math.min(n, details.episodes);
    }
    try {
      await addEntry({
        ...details,
        status: status.value,
        episodes_watched: n,
        rewatch_count: Math.max(0, Math.floor(Number(rewatches.value) || 0)),
        rating: rating.value === '' ? null : Number(rating.value),
        started_on: started.value || null,
        finished_on: finished.value || null,
        notes: notes.value,
      });
      dlg.close();
    } catch (e) {
      msg.textContent = `Could not add: ${e.message}`;
      save.disabled = false;
    }
  };

  lookup({ action: 'details', source: r.source, id: r.source_id })
    .then(({ entry: d }) => {
      details = d;
      if (d.kind === 'series') {
        if (d.episodes != null) watched.max = d.episodes;
        watchedLabel.firstChild.textContent = `Episodes watched${d.episodes != null ? ` / ${d.episodes}` : ''}`;
        watchedLabel.hidden = false;
      }
      syncEpisodes();
      msg.textContent = '';
      save.disabled = false;
    })
    .catch((e) => {
      msg.textContent = `Could not load details: ${e.message}`;
    });

  dlg.replaceChildren(form);
  dlg.onclick = (ev) => {
    if (ev.target === dlg) dlg.close(); // click on the backdrop
  };
  dlg.showModal();
  status.focus();
}

async function addEntry(entry) {
  const { data, error } = await db.from('tracker_entries').insert(entry).select().single();
  if (error) throw new Error(error.code === '23505' ? 'already in your library' : error.message);
  entries.unshift(data);
  renderAll();
  setResults(shown); // refresh "Add" -> "In library" on the open results
}

// ---- library --------------------------------------------------------------------------------

async function patch(entry, changes, savedEl) {
  Object.assign(entry, changes);
  if (savedEl) savedEl.textContent = 'Saving…';
  const { error } = await db.from('tracker_entries').update(changes).eq('id', entry.id);
  if (savedEl) savedEl.textContent = error ? `Not saved: ${error.message}` : 'Saved';
  renderStats();
  return !error;
}

// `position` is the entry's place in the list as currently filtered and sorted.
function entryCard(e, position) {
  const saved = el('span', { className: 'saved' });
  const li = el('li', { className: 'entry' });
  li.dataset.id = e.id;
  const pill = el('span', { className: 'pill' });
  const progress = el('p', { className: 'progress' });
  // The always-visible part of the card; colour and label follow the status.
  const refreshSummary = () => {
    li.dataset.status = e.status;
    pill.textContent = STATUS_LABEL[e.status];
    progress.textContent = [
      e.kind === 'series' && `${e.episodes_watched}${e.episodes != null ? ` / ${e.episodes}` : ''} eps watched`,
      e.rating != null && `★ ${Number(e.rating).toFixed(1)}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const timeEl = el('p', { className: 'time' });
  const refreshTime = () => {
    const per = fullMinutes(e);
    timeEl.textContent =
      `Watched: ${fmtDuration(minutesWatched(e))}` + (per ? ` · one watch-through ${fmtDuration(per)}` : '');
  };

  const status = el('select');
  for (const [v, label] of STATUSES) status.append(new Option(label, v, false, v === e.status));
  status.onchange = async () => {
    const changes = { status: status.value };
    if (status.value === 'completed') changes.episodes_watched = e.episodes ?? e.episodes_watched;
    Object.assign(changes, datesFor(status.value, e.started_on, e.finished_on));
    await patch(e, changes, saved);
    renderLibrary();
  };

  const rating = ratingSelect(e.rating);
  rating.onchange = async () => {
    await patch(e, { rating: rating.value === '' ? null : Number(rating.value) }, saved);
    refreshSummary();
    if ($('sort').value === 'rating') renderLibrary();
  };

  // A bad range is rejected up front and the input snaps back to the saved value.
  const dateInput = (field, other) => {
    const input = el('input', { type: 'date', value: e[field] ?? '' });
    input.onchange = async () => {
      const value = input.value || null;
      const bad = field === 'started_on' ? datesError(value, e[other]) : datesError(e[other], value);
      if (bad) {
        input.value = e[field] ?? '';
        saved.textContent = `Not saved: ${bad}`;
        return;
      }
      await patch(e, { [field]: value }, saved);
      if ($('sort').value === 'finished') renderLibrary();
    };
    return input;
  };

  const controls = el(
    'div',
    { className: 'controls' },
    labeled('Status', status),
    labeled('Rating /10', rating),
    labeled('Started', dateInput('started_on', 'finished_on')),
    labeled('Finished', dateInput('finished_on', 'started_on')),
  );

  if (e.kind === 'series') {
    const watched = el('input', { type: 'number', min: 0, value: e.episodes_watched });
    if (e.episodes != null) watched.max = e.episodes;
    watched.onchange = async () => {
      let n = Math.max(0, Math.floor(Number(watched.value) || 0));
      if (e.episodes != null) n = Math.min(n, e.episodes);
      watched.value = n;
      await patch(e, { episodes_watched: n }, saved);
      refreshSummary();
      refreshTime();
    };
    controls.append(labeled(`Episodes watched${e.episodes != null ? ` / ${e.episodes}` : ''}`, watched));
  }

  const count = el('span', { textContent: String(e.rewatch_count) });
  const step = (delta) => async () => {
    const n = Math.max(0, e.rewatch_count + delta);
    if (n === e.rewatch_count) return;
    count.textContent = String(n);
    await patch(e, { rewatch_count: n }, saved);
    refreshTime();
  };
  controls.append(
    labeled(
      'Rewatches',
      el(
        'div',
        { className: 'rewatch' },
        el('button', { type: 'button', className: 'ghost', textContent: '−', ariaLabel: 'Fewer rewatches', onclick: step(-1) }),
        count,
        el('button', { type: 'button', className: 'ghost', textContent: '+', ariaLabel: 'More rewatches', onclick: step(1) }),
      ),
    ),
  );

  const notes = el('textarea', { value: e.notes, placeholder: 'Notes', ariaLabel: `Notes for ${e.title}` });
  let timer;
  const saveNotes = () => {
    clearTimeout(timer);
    if (notes.value !== e.notes) patch(e, { notes: notes.value }, saved);
  };
  notes.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(saveNotes, 800);
  };
  notes.onblur = saveNotes;

  const remove = el('button', { type: 'button', className: 'danger', textContent: 'Remove' });
  remove.onclick = async () => {
    if (!confirm(`Remove "${e.title}" from your library? Its rating and notes will be deleted.`)) return;
    const { error } = await db.from('tracker_entries').delete().eq('id', e.id);
    if (error) return (saved.textContent = `Not removed: ${error.message}`);
    entries = entries.filter((x) => x.id !== e.id);
    renderAll();
  };

  const size =
    e.kind === 'movie'
      ? e.runtime_minutes && `${e.runtime_minutes} min`
      : [e.episodes != null ? `${e.episodes} eps` : 'ongoing', e.episode_minutes && `${e.episode_minutes} min each`]
          .filter(Boolean)
          .join(' × ');
  const kindLabel = e.kind === 'movie' ? 'Movie' : 'Series';
  const shortMeta = [kindLabel, e.release_date?.slice(0, 4), size].filter(Boolean).join(' · ');
  const fullMeta = [
    kindLabel,
    e.release_date,
    size,
    e.studios.length && `Studio: ${e.studios.join(', ')}`,
    e.directors.length && `Director: ${e.directors.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const advanced = el(
    'details',
    { className: 'advanced' },
    el('summary', { textContent: 'Advanced details' }),
    el('p', { className: 'meta', textContent: fullMeta }),
    controls,
    timeEl,
    notes,
    el('div', { className: 'foot' }, saved, remove),
  );
  advanced.open = openIds.has(e.id);
  advanced.ontoggle = () => {
    if (advanced.open) openIds.add(e.id);
    else openIds.delete(e.id);
    syncToggleAll();
  };

  refreshSummary();
  refreshTime();
  li.append(
    el('span', { className: 'rank', textContent: String(position), }),
    poster(e.poster_url, e.title, 'poster'),
    el(
      'div',
      { className: 'main' },
      el('div', { className: 'head' }, el('h2', { textContent: e.title, title: e.title }), pill),
      el('p', { className: 'meta', textContent: shortMeta, title: shortMeta }),
      progress,
      advanced,
    ),
  );
  return li;
}

function labeled(text, control) {
  return el('label', {}, text, control);
}

// ---- MyAnimeList import ---------------------------------------------------------------------

// Reads a MAL export, matches every title on AniList by its MAL id, then saves the new ones.
// Titles already in the library are left alone; titles AniList does not know are listed at the end.
async function runImport(file) {
  const msg = $('import-msg');
  const report = $('import-report');
  const button = $('import-btn');
  report.hidden = true;
  report.replaceChildren();
  button.disabled = true;
  try {
    msg.textContent = 'Reading file…';
    const items = parseMalExport(await readExportText(file));

    const have = new Set(entries.map((e) => `${e.source}:${e.source_id}`));
    const rows = [];
    const notFound = [];
    let alreadyHave = 0;
    for (let i = 0; i < items.length; i += 20) {
      const chunk = items.slice(i, i + 20);
      msg.textContent = `Matching titles… ${Math.min(i + 20, items.length)} / ${items.length}`;
      const { matches, missing } = await lookup({ action: 'bulk', source: SOURCE, mal_ids: chunk.map((c) => c.malId) });
      const byId = new Map(chunk.map((c) => [c.malId, c]));
      for (const { mal_id, entry } of matches) {
        const key = `${entry.source}:${entry.source_id}`;
        if (have.has(key)) {
          alreadyHave++;
          continue;
        }
        have.add(key);
        rows.push(buildRow(byId.get(mal_id), entry));
      }
      for (const id of missing) notFound.push(byId.get(id).title || `MyAnimeList #${id}`);
    }

    let saved = 0;
    const failed = [];
    for (let i = 0; i < rows.length; i += 50) {
      msg.textContent = `Saving… ${Math.min(i + 50, rows.length)} / ${rows.length}`;
      const chunk = rows.slice(i, i + 50);
      const { data, error } = await db.from('tracker_entries').insert(chunk).select();
      if (!error) {
        entries.unshift(...data);
        saved += data.length;
        continue;
      }
      // One bad row should not sink its neighbours: retry the chunk one title at a time.
      for (const row of chunk) {
        const one = await db.from('tracker_entries').insert(row).select().single();
        if (one.error) failed.push(`${row.title} (${one.error.message})`);
        else {
          entries.unshift(one.data);
          saved++;
        }
      }
    }
    renderAll();

    msg.textContent =
      `Imported ${saved} of ${items.length} titles.` +
      (alreadyHave ? ` ${alreadyHave} already in your library.` : '') +
      (items.length && !rows.length && !notFound.length && !alreadyHave ? ' Nothing to import.' : '');
    for (const [label, list] of [
      [`${notFound.length} not found on AniList`, notFound],
      [`${failed.length} could not be saved`, failed],
    ]) {
      if (!list.length) continue;
      report.append(el('details', {}, el('summary', { textContent: label }), el('ul', {}, ...list.map((t) => el('li', { textContent: t })))));
      report.hidden = false;
    }
  } catch (e) {
    msg.textContent = `Import failed: ${e.message}`;
  } finally {
    button.disabled = false;
    $('import-file').value = '';
  }
}

// Each category sorts by `get`; `desc` is its natural direction (newest, highest, A to Z...).
// The direction button flips it. Entries with no value (unrated, no date) always sort last.
const SORTS = {
  added: { get: (e) => e.created_at, desc: true, label: { desc: 'Newest first', asc: 'Oldest first' } },
  rating: { get: (e) => (e.rating == null ? null : Number(e.rating)), desc: true, label: { desc: 'High to low', asc: 'Low to high' } },
  title: { get: (e) => e.title, desc: false, label: { desc: 'Z to A', asc: 'A to Z' } },
  release: { get: (e) => e.release_date, desc: true, label: { desc: 'Newest first', asc: 'Oldest first' } },
  time: { get: (e) => minutesWatched(e), desc: true, label: { desc: 'Most first', asc: 'Least first' } },
  finished: { get: (e) => e.finished_on, desc: true, label: { desc: 'Newest first', asc: 'Oldest first' } },
};
let sortDesc = SORTS.rating.desc; // the library opens sorted by rating (matches the selected option in index.html)

function compareBy(sort) {
  return (a, b) => {
    const va = sort.get(a);
    const vb = sort.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortDesc ? -cmp : cmp;
  };
}

function updateSortButton() {
  const sort = SORTS[$('sort').value];
  $('sort-dir').textContent = `${sortDesc ? '↓' : '↑'} ${sort.label[sortDesc ? 'desc' : 'asc']}`;
}

function renderLibrary() {
  const status = $('filter-status').value;
  const text = $('filter-text').value.trim().toLowerCase();
  const shown = entries
    .filter((e) => (!status || e.status === status) && (!text || e.title.toLowerCase().includes(text)))
    .sort(compareBy(SORTS[$('sort').value]));
  $('library').replaceChildren(...shown.map((e, i) => entryCard(e, i + 1)));
  $('empty').hidden = entries.length > 0;
  syncToggleAll();
}

// "Expand all" / "Collapse all" follows whether every visible card is open.
function syncToggleAll() {
  const cards = [...document.querySelectorAll('#library .advanced')];
  $('toggle-label').textContent = cards.length && cards.every((d) => d.open) ? 'Collapse all' : 'Expand all';
  $('toggle-all').disabled = !cards.length;
}

function toggleAll() {
  const cards = [...document.querySelectorAll('#library .entry')];
  const open = !cards.every((c) => c.querySelector('.advanced').open);
  for (const c of cards) {
    c.querySelector('.advanced').open = open;
    if (open) openIds.add(c.dataset.id);
    else openIds.delete(c.dataset.id);
  }
  syncToggleAll();
}

function setLayout(layout) {
  $('library').dataset.layout = layout;
  $('layout-list').setAttribute('aria-pressed', String(layout === 'list'));
  $('layout-grid').setAttribute('aria-pressed', String(layout === 'grid'));
  try {
    localStorage.setItem('anime-layout', layout);
  } catch {
    // storage unavailable (private window): the choice just won't be remembered
  }
}

function renderStats() {
  const rated = entries.filter((e) => e.rating != null);
  const avg = rated.length ? (rated.reduce((sum, e) => sum + Number(e.rating), 0) / rated.length).toFixed(2) : '–';
  const total = entries.reduce((sum, e) => sum + minutesWatched(e), 0);
  const cell = (label, value) =>
    el('div', { className: 'stat-cell' }, el('span', { className: 'stat-label', textContent: label }), el('span', { className: 'stat-value', textContent: value }));
  $('count').textContent = `${entries.length} ${entries.length === 1 ? 'title' : 'titles'}`;
  $('stats').replaceChildren(
    cell('Completed', String(entries.filter((e) => e.status === 'completed').length)),
    cell('Time watched', fmtDuration(total)),
    cell('Avg rating', avg),
  );
}

function renderAll() {
  renderStats();
  renderLibrary();
}

// ---- start ----------------------------------------------------------------------------------

const session = await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}

$('app').hidden = false;
$('signout').onclick = signOut;
{
  const user = session.user;
  const meta = user.user_metadata ?? {};
  const local = (user.email ?? '').split('@')[0];
  let name = meta.full_name || meta.name || (local ? local.charAt(0).toUpperCase() + local.slice(1) : '');
  const greet = () => ($('welcome').textContent = name ? `Welcome back, ${name}.` : 'Welcome back.');
  $('handle').textContent = local ? `@${local}` : '';
  greet();
  // the saved name and handle replace the guesses above
  loadProfile(user.id).then((profile) => {
    if (!profile) return;
    if (profile.display_name) {
      name = profile.display_name;
      greet();
    }
    if (profile.handle) {
      $('handle').textContent = `@${profile.handle}`;
      $('page-link').href = `/u/${profile.handle}`;
      $('page-link').hidden = false;
    }
  });
}
$('home-link').href = HOME;
$('search-form').onsubmit = (ev) => {
  ev.preventDefault();
  runSearch();
};
$('search-q').oninput = queueSearch;
$('import-btn').onclick = () => $('import-file').click();
$('import-file').onchange = (ev) => {
  const file = ev.target.files[0];
  if (file) runImport(file);
};
$('search-q').onkeydown = (ev) => {
  if (ev.key === 'Escape') {
    $('search-q').value = '';
    runSearch();
  }
};
$('filter-status').onchange = renderLibrary;
$('sort').onchange = () => {
  sortDesc = SORTS[$('sort').value].desc; // each category starts in its natural direction
  updateSortButton();
  renderLibrary();
};
$('sort-dir').onclick = () => {
  sortDesc = !sortDesc;
  updateSortButton();
  renderLibrary();
};
updateSortButton();
$('filter-text').oninput = renderLibrary;
$('toggle-all').onclick = toggleAll;
$('layout-list').onclick = () => setLayout('list');
$('layout-grid').onclick = () => setLayout('grid');
{
  let saved = null;
  try {
    saved = localStorage.getItem('anime-layout');
  } catch {
    // ignore
  }
  setLayout(saved === 'grid' ? 'grid' : 'list');
}

// ---- library visibility: private (only me) or public (shown on my page) ---------------------

let libraryPublic = false;
let toastTimer;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2400);
}
function renderVisibility() {
  $('library-vis').setAttribute('aria-pressed', String(libraryPublic));
  $('library-vis-label').textContent = libraryPublic ? 'Library public' : 'Library private';
}
{
  const { data: settings } = await db.from('profile_settings').select('library_public').eq('user_id', session.user.id).maybeSingle();
  libraryPublic = Boolean(settings?.library_public);
  renderVisibility();
}
$('library-vis').onclick = async () => {
  const next = !libraryPublic;
  const { error } = await db.from('profile_settings').upsert({ user_id: session.user.id, library_public: next }, { onConflict: 'user_id' });
  if (error) return toast(`Could not change visibility: ${error.message}`, true);
  libraryPublic = next;
  renderVisibility();
  toast(next ? 'Your library is now public' : 'Your library is now private');
};

const { data, error } = await db.from('tracker_entries').select('*');
if (error) $('empty').textContent = `Could not load your library: ${error.message}`;
entries = data ?? [];
renderAll();
if (error) $('empty').hidden = false;
