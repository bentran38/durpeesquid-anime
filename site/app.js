// Anime tracker: search AniList (through the media-search Edge Function), keep a personal
// library in anime.tracker_entries, and total up time watched.
import { supabase, requireLogin, hasAccess, signOut, HOME } from 'https://www.durpeesquid.com/auth.js';

const SLUG = 'anime';
const db = supabase.schema('anime'); // this project's tables live in the `anime` schema
const STATUSES = [
  ['planned', 'Planned'],
  ['watching', 'Watching'],
  ['completed', 'Completed'],
  ['on_hold', 'On hold'],
  ['dropped', 'Dropped'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

let entries = [];

// ---- calculations ---------------------------------------------------------------------------

// Minutes for one full watch-through.
function fullMinutes(e) {
  if (e.kind === 'movie') return e.runtime_minutes ?? 0;
  return (e.episodes ?? e.episodes_watched) * (e.episode_minutes ?? 0);
}

// Minutes actually spent: the first pass (partial unless completed) plus every rewatch.
function minutesWatched(e) {
  if (e.status === 'planned') return 0;
  const full = fullMinutes(e);
  let first;
  if (e.status === 'completed') first = full;
  else if (e.kind === 'movie') first = 0;
  else first = Math.min(e.episodes_watched, e.episodes ?? Infinity) * (e.episode_minutes ?? 0);
  return first + e.rewatch_count * full;
}

function fmtDuration(min) {
  if (!min) return '0m';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ');
}

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
    { className: have ? 'have' : '' },
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
  status.onchange = syncEpisodes;

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
    ),
    notes,
    msg,
    el('div', { className: 'foot' }, cancel, save),
  );

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!details) return;
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

function entryCard(e) {
  const saved = el('span', { className: 'saved' });
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
    await patch(e, changes, saved);
    renderLibrary();
  };

  const rating = ratingSelect(e.rating);
  rating.onchange = async () => {
    await patch(e, { rating: rating.value === '' ? null : Number(rating.value) }, saved);
    if ($('sort').value === 'rating') renderLibrary();
  };

  const controls = el(
    'div',
    { className: 'controls' },
    labeled('Status', status),
    labeled('Rating /10', rating),
  );

  if (e.kind === 'series') {
    const watched = el('input', { type: 'number', min: 0, value: e.episodes_watched });
    if (e.episodes != null) watched.max = e.episodes;
    watched.onchange = async () => {
      let n = Math.max(0, Math.floor(Number(watched.value) || 0));
      if (e.episodes != null) n = Math.min(n, e.episodes);
      watched.value = n;
      await patch(e, { episodes_watched: n }, saved);
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
  const meta = [
    e.kind === 'movie' ? 'Movie' : 'Series',
    e.release_date,
    size,
    e.studios.length && `Studio: ${e.studios.join(', ')}`,
    e.directors.length && `Director: ${e.directors.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  refreshTime();
  return el(
    'li',
    { className: 'entry' },
    poster(e.poster_url, e.title, 'poster'),
    el(
      'div',
      { className: 'main' },
      el('h2', { textContent: e.title }),
      el('p', { className: 'meta', textContent: meta }),
      controls,
      timeEl,
      notes,
      el('div', { className: 'foot' }, saved, remove),
    ),
  );
}

function labeled(text, control) {
  return el('label', {}, text, control);
}

const SORTS = {
  added: (a, b) => b.created_at.localeCompare(a.created_at),
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  title: (a, b) => a.title.localeCompare(b.title),
  release: (a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  time: (a, b) => minutesWatched(b) - minutesWatched(a),
};

function renderLibrary() {
  const status = $('filter-status').value;
  const text = $('filter-text').value.trim().toLowerCase();
  const shown = entries
    .filter((e) => (!status || e.status === status) && (!text || e.title.toLowerCase().includes(text)))
    .sort(SORTS[$('sort').value]);
  $('library').replaceChildren(...shown.map(entryCard));
  $('empty').hidden = entries.length > 0;
}

function renderStats() {
  const rated = entries.filter((e) => e.rating != null);
  const avg = rated.length ? (rated.reduce((s, e) => s + Number(e.rating), 0) / rated.length).toFixed(2) : '–';
  const total = entries.reduce((s, e) => s + minutesWatched(e), 0);
  const cell = (value, label) => el('div', { className: 'stat' }, el('b', { textContent: value }), el('span', { textContent: label }));
  $('stats').replaceChildren(
    cell(String(entries.length), 'Titles'),
    cell(String(entries.filter((e) => e.status === 'completed').length), 'Completed'),
    cell(fmtDuration(total), `Time watched (${(total / 60).toFixed(0)} h)`),
    cell(avg, 'Average rating'),
  );
}

function renderAll() {
  renderStats();
  renderLibrary();
}

// ---- start ----------------------------------------------------------------------------------

await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}

$('app').hidden = false;
$('signout').onclick = signOut;
$('home-link').href = HOME;
$('search-form').onsubmit = (ev) => {
  ev.preventDefault();
  runSearch();
};
$('search-q').oninput = queueSearch;
$('search-q').onkeydown = (ev) => {
  if (ev.key === 'Escape') {
    $('search-q').value = '';
    runSearch();
  }
};
for (const id of ['filter-status', 'sort']) $(id).onchange = renderLibrary;
$('filter-text').oninput = renderLibrary;

const { data, error } = await db.from('tracker_entries').select('*');
if (error) $('empty').textContent = `Could not load your library: ${error.message}`;
entries = data ?? [];
renderAll();
if (error) $('empty').hidden = false;
