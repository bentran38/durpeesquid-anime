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

async function runSearch(ev) {
  ev.preventDefault();
  const msg = $('search-msg');
  const list = $('results');
  list.replaceChildren();
  msg.textContent = 'Searching…';
  try {
    const { results } = await lookup({ action: 'search', source: 'anilist', q: $('search-q').value });
    msg.textContent = results.length ? '' : 'No results.';
    for (const r of results) list.append(resultRow(r));
  } catch (e) {
    msg.textContent = `Search failed: ${e.message}`;
  }
}

function resultRow(r) {
  const have = entries.some((e) => e.source === r.source && e.source_id === r.source_id);
  const sub = [r.type, r.year, r.episodes ? `${r.episodes} eps` : null].filter(Boolean).join(' · ');
  const btn = el('button', { type: 'button', textContent: have ? 'In library' : 'Add', disabled: have });
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await addEntry(r);
      btn.textContent = 'Added';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Add';
      $('search-msg').textContent = `Could not add: ${e.message}`;
    }
  };
  return el(
    'li',
    {},
    poster(r.poster_url, r.title, 'poster'),
    el('div', { className: 'info' }, el('span', { textContent: r.title }), el('small', { textContent: sub })),
    btn,
  );
}

function poster(url, alt, className) {
  const img = el('img', { className, alt: '', loading: 'lazy' });
  if (typeof url === 'string' && url.startsWith('https://')) img.src = url;
  else img.removeAttribute('src');
  img.title = alt;
  return img;
}

async function addEntry(r) {
  const { entry } = await lookup({ action: 'details', source: r.source, id: r.source_id });
  const { data, error } = await db.from('tracker_entries').insert(entry).select().single();
  if (error) throw new Error(error.code === '23505' ? 'already in your library' : error.message);
  entries.unshift(data);
  renderAll();
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

  const rating = el('select');
  rating.append(new Option('Unrated', ''));
  for (let r = 10; r >= 0.5; r -= 0.5) rating.append(new Option(r.toFixed(1), String(r), false, e.rating === r));
  if (e.rating == null) rating.value = '';
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
$('search-form').onsubmit = runSearch;
for (const id of ['filter-status', 'sort']) $(id).onchange = renderLibrary;
$('filter-text').oninput = renderLibrary;

const { data, error } = await db.from('tracker_entries').select('*');
if (error) $('empty').textContent = `Could not load your library: ${error.message}`;
entries = data ?? [];
renderAll();
if (error) $('empty').hidden = false;
