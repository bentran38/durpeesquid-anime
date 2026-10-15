// Top Lists: build a Top 10 or a 3x3 from your tracker library and share it with the other
// signed-in anime users. A list stores a snapshot of its picks, so others can read it without
// being able to read your library.
import { supabase, requireLogin, hasAccess, signOut, HOME } from 'https://www.durpeesquid.com/auth.js';

const SLUG = 'anime';
const db = supabase.schema('anime');
const KINDS = { top10: { label: 'Top 10', max: 10 }, grid3: { label: '3x3', max: 9 } };
const AUTHOR_KEY = 'anime-author-name';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};

let me = null; // signed-in user id
let library = []; // tracker entries offered in the picker
let lists = []; // every list this user may see
let draft = blankDraft();

function blankDraft() {
  return { id: null, kind: 'top10', items: [] };
}

// ---- helpers --------------------------------------------------------------------------------

function poster(url, className) {
  const img = el('img', { className, alt: '', loading: 'lazy' });
  if (typeof url === 'string' && url.startsWith('https://')) img.src = url;
  else img.removeAttribute('src');
  return img;
}

const itemFrom = (e) => ({
  source_id: e.source_id,
  title: e.title,
  poster_url: e.poster_url,
  rating: e.rating == null ? null : Number(e.rating),
  year: e.release_date ? Number(String(e.release_date).slice(0, 4)) : null,
});

const meta = (it) => [it.year, it.rating != null && `★ ${Number(it.rating).toFixed(1)}`].filter(Boolean).join(' · ');
const shareUrl = (id) => `${location.origin}/lists?list=${id}`;
const say = (text) => ($('editor-msg').textContent = text);

async function copyLink(id, button) {
  const url = shareUrl(id);
  try {
    await navigator.clipboard.writeText(url);
    const old = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => (button.textContent = old), 1500);
  } catch {
    window.prompt('Copy this link', url); // clipboard blocked: let the user copy it by hand
  }
}

// One renderer for the editor preview, the shared view and (read-only) everywhere else.
// Pass onMove/onRemove to get the reorder and remove buttons.
function renderList(kind, items, onMove, onRemove) {
  const controls = (i, back, forward) =>
    onMove &&
    el(
      'div',
      { className: 'ctl' },
      el('button', { type: 'button', className: 'ghost', textContent: back, ariaLabel: 'Move earlier', disabled: i === 0, onclick: () => onMove(i, -1) }),
      el('button', { type: 'button', className: 'ghost', textContent: forward, ariaLabel: 'Move later', disabled: i === items.length - 1, onclick: () => onMove(i, 1) }),
      el('button', { type: 'button', className: 'ghost', textContent: '✕', ariaLabel: `Remove ${items[i].title}`, onclick: () => onRemove(i) }),
    );

  if (kind === 'top10') {
    return el(
      'ol',
      { className: 'top10', ariaLabel: 'Top 10' },
      ...items.map((it, i) =>
        el(
          'li',
          {},
          el('span', { className: 'num', textContent: String(i + 1) }),
          poster(it.poster_url, 'poster'),
          el('div', { className: 'info' }, el('span', { textContent: it.title }), el('small', { textContent: meta(it) })),
          controls(i, '▲', '▼'),
        ),
      ),
    );
  }

  const tiles = items.map((it, i) =>
    el('li', { className: 'tile', title: it.title }, poster(it.poster_url, 'cover'), el('span', { className: 'cap', textContent: it.title }), controls(i, '◀', '▶')),
  );
  while (tiles.length < KINDS.grid3.max) tiles.push(el('li', { className: 'tile empty' }));
  return el('ol', { className: 'grid3', ariaLabel: '3x3' }, ...tiles);
}

// ---- editor ---------------------------------------------------------------------------------

function setKind(kind) {
  draft.kind = kind;
  const { max } = KINDS[kind];
  if (draft.items.length > max) {
    draft.items.length = max;
    say(`A ${KINDS[kind].label} holds ${max}, so the extra picks were dropped.`);
  }
  for (const k of Object.keys(KINDS)) $(`kind-${k}`).setAttribute('aria-pressed', String(k === kind));
  renderDraft();
}

function renderDraft() {
  const { kind, items } = draft;
  $('count').textContent = `(${items.length} / ${KINDS[kind].max})`;
  const empty = !items.length && kind === 'top10';
  $('preview').replaceChildren(
    empty ? el('p', { className: 'muted', textContent: 'Pick titles from your library to build the list.' }) : renderList(kind, items, move, remove),
  );
  $('save-list').disabled = !items.length;
  renderPicker();
}

function move(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= draft.items.length) return;
  [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]];
  renderDraft();
}

function remove(i) {
  draft.items.splice(i, 1);
  renderDraft();
}

function add(entry) {
  if (draft.items.length >= KINDS[draft.kind].max || draft.items.some((it) => it.source_id === entry.source_id)) return;
  draft.items.push(itemFrom(entry));
  say('');
  renderDraft();
}

const PICKER_LIMIT = 60;

function renderPicker() {
  const q = $('pick-filter').value.trim().toLowerCase();
  const taken = new Set(draft.items.map((it) => it.source_id));
  const full = draft.items.length >= KINDS[draft.kind].max;
  const matches = library
    .filter((e) => !q || e.title.toLowerCase().includes(q))
    .sort((a, b) => Number(b.rating ?? -1) - Number(a.rating ?? -1) || a.title.localeCompare(b.title));

  $('picker').replaceChildren(
    ...matches.slice(0, PICKER_LIMIT).map((e) => {
      const used = taken.has(e.source_id);
      const button = el('button', { type: 'button', textContent: used ? 'Added' : 'Add', disabled: used || full });
      button.onclick = () => add(e);
      return el(
        'li',
        {},
        poster(e.poster_url, 'poster'),
        el('div', { className: 'info' }, el('span', { textContent: e.title }), el('small', { textContent: meta(itemFrom(e)) })),
        button,
      );
    }),
  );
  const note = $('picker-note');
  note.hidden = matches.length <= PICKER_LIMIT && matches.length > 0;
  note.textContent = !matches.length
    ? library.length
      ? 'No titles match.'
      : 'Your library is empty. Add titles in the tracker first.'
    : `Showing ${PICKER_LIMIT} of ${matches.length}. Filter to narrow it down.`;
}

function resetDraft() {
  draft = blankDraft();
  $('list-title').value = '';
  $('editor-title').textContent = 'Create a list';
  $('share-box').hidden = true;
  say('');
  setKind('top10');
}

function editList(list) {
  draft = { id: list.id, kind: list.kind, items: list.items.map((it) => ({ ...it })) };
  $('list-title').value = list.title;
  $('author-name').value = list.author_name;
  $('editor-title').textContent = 'Edit your list';
  $('share-box').hidden = true;
  say('');
  setKind(list.kind);
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function save() {
  const title = $('list-title').value.trim();
  const authorName = $('author-name').value.trim();
  if (!title) return say('Give your list a title first.');
  try {
    localStorage.setItem(AUTHOR_KEY, authorName);
  } catch {
    // not remembered; fine
  }

  $('save-list').disabled = true;
  say('Saving…');
  const payload = { kind: draft.kind, title, author_name: authorName, items: draft.items };
  const request = draft.id ? db.from('shared_lists').update(payload).eq('id', draft.id) : db.from('shared_lists').insert(payload);
  const { data, error } = await request.select().single();
  $('save-list').disabled = false;
  if (error) return say(`Could not save: ${error.message}`);

  draft.id = data.id;
  $('editor-title').textContent = 'Edit your list';
  $('share-link').value = shareUrl(data.id);
  $('share-box').hidden = false;
  say('Saved. Anyone signed in to the anime tracker can open this link.');
  await loadLists();
}

// ---- saved lists ----------------------------------------------------------------------------

function listCard(l) {
  const mine = l.user_id === me;
  const by = mine ? 'you' : l.author_name || 'someone';
  const copy = el('button', { type: 'button', className: 'ghost', textContent: 'Copy link' });
  copy.onclick = () => copyLink(l.id, copy);
  const actions = el('div', { className: 'row' }, el('a', { className: 'btn-link', href: shareUrl(l.id), textContent: 'Open' }), copy);

  if (mine) {
    actions.append(
      el('button', { type: 'button', className: 'ghost', textContent: 'Edit', onclick: () => editList(l) }),
      el('button', {
        type: 'button',
        className: 'danger',
        textContent: 'Delete',
        onclick: async () => {
          if (!confirm(`Delete "${l.title}"? Its link will stop working.`)) return;
          const { error } = await db.from('shared_lists').delete().eq('id', l.id);
          if (error) return say(`Could not delete: ${error.message}`);
          if (draft.id === l.id) resetDraft();
          await loadLists();
        },
      }),
    );
  }

  return el(
    'li',
    { className: 'list-card' },
    el('h3', { textContent: l.title }),
    el('p', { className: 'muted', textContent: `${KINDS[l.kind].label} · ${l.items.length} picks · by ${by} · ${new Date(l.created_at).toLocaleDateString()}` }),
    el('div', { className: 'thumbs' }, ...l.items.slice(0, 5).map((it) => poster(it.poster_url, 'thumb'))),
    actions,
  );
}

async function loadLists() {
  const { data, error } = await db.from('shared_lists').select('*').order('created_at', { ascending: false });
  if (error) {
    $('mine-empty').hidden = false;
    $('mine-empty').textContent = `Could not load lists: ${error.message}`;
    return;
  }
  lists = data ?? [];
  const mine = lists.filter((l) => l.user_id === me);
  const others = lists.filter((l) => l.user_id !== me);
  $('mine').replaceChildren(...mine.map(listCard));
  $('others').replaceChildren(...others.map(listCard));
  $('mine-empty').hidden = mine.length > 0;
  $('mine-empty').textContent = "You haven't saved a list yet.";
  $('others-empty').hidden = others.length > 0;
}

// ---- opening a shared link ------------------------------------------------------------------

async function showView(id) {
  const view = $('view');
  $('workspace').hidden = true;
  view.hidden = false;
  view.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));

  const { data: list, error } = await db.from('shared_lists').select('*').eq('id', id).maybeSingle();
  if (error || !list) {
    view.replaceChildren(
      el('p', { textContent: error ? `Could not load this list: ${error.message}` : "This list doesn't exist, or it was deleted." }),
      el('a', { className: 'btn-link', href: '/lists', textContent: 'All lists' }),
    );
    return;
  }

  const mine = list.user_id === me;
  document.title = `${list.title} · Top Lists`;
  const copy = el('button', { type: 'button', className: 'ghost', textContent: 'Copy link' });
  copy.onclick = () => copyLink(list.id, copy);
  view.replaceChildren(
    el('h2', { textContent: list.title }),
    el('p', { className: 'muted', textContent: `${KINDS[list.kind].label} by ${mine ? 'you' : list.author_name || 'someone'} · ${new Date(list.created_at).toLocaleDateString()}` }),
    renderList(list.kind, list.items),
    el(
      'div',
      { className: 'row view-actions' },
      el('a', { className: 'btn-link', href: '/lists', textContent: 'All lists' }),
      copy,
      mine &&
        el('button', {
          type: 'button',
          textContent: 'Edit',
          onclick: () => {
            history.replaceState(null, '', '/lists');
            view.hidden = true;
            $('workspace').hidden = false;
            editList(list);
          },
        }),
    ),
  );
}

// ---- start ----------------------------------------------------------------------------------

const session = await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}
me = session.user.id;

$('app').hidden = false;
$('signout').onclick = signOut;
$('home-link').href = HOME;
$('kind-top10').onclick = () => setKind('top10');
$('kind-grid3').onclick = () => setKind('grid3');
$('pick-filter').oninput = renderPicker;
$('save-list').onclick = save;
$('reset-list').onclick = resetDraft;
$('copy-share').onclick = () => copyLink(draft.id, $('copy-share'));
try {
  $('author-name').value = localStorage.getItem(AUTHOR_KEY) ?? '';
} catch {
  // ignore
}

const [libraryResult] = await Promise.all([
  db.from('tracker_entries').select('source_id, title, poster_url, rating, release_date'),
  loadLists(),
]);
library = libraryResult.data ?? [];
if (libraryResult.error) say(`Could not load your library: ${libraryResult.error.message}`);
renderDraft();

const wanted = new URLSearchParams(location.search).get('list');
if (wanted) await showView(wanted);
