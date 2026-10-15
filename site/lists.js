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
  const img = el('img', { className, alt: '', loading: 'lazy', draggable: false });
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
// Pass `edit` ({ reorder, remove }) to make the picks draggable and removable.
function renderList(kind, items, edit) {
  // Each editable pick carries its position so dragging and the keyboard know where it is.
  const editable = (li, i) => {
    if (!edit) return li;
    li.dataset.index = String(i);
    li.tabIndex = 0;
    li.title = items[i].title;
    li.onkeydown = (ev) => {
      if (!ev.shiftKey || ev.target !== li) return;
      const down = kind === 'grid3' ? 3 : 1;
      const step = { ArrowUp: -down, ArrowDown: down, ArrowLeft: -1, ArrowRight: 1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      edit.reorder(i, i + step, true);
    };
    return li;
  };
  const removeButton = (i) =>
    edit &&
    el(
      'div',
      { className: 'ctl' },
      el('button', { type: 'button', className: 'ghost', textContent: '✕', ariaLabel: `Remove ${items[i].title}`, onclick: () => edit.remove(i) }),
    );

  if (kind === 'top10') {
    return el(
      'ol',
      { className: 'top10', ariaLabel: 'Top 10' },
      ...items.map((it, i) =>
        editable(
          el(
            'li',
            {},
            el('span', { className: 'num', textContent: String(i + 1) }),
            poster(it.poster_url, 'poster'),
            el('div', { className: 'info' }, el('span', { textContent: it.title }), el('small', { textContent: meta(it) })),
            removeButton(i),
          ),
          i,
        ),
      ),
    );
  }

  const tiles = items.map((it, i) =>
    editable(el('li', { className: 'tile', title: it.title }, poster(it.poster_url, 'cover'), el('span', { className: 'cap', textContent: it.title }), removeButton(i)), i),
  );
  while (tiles.length < KINDS.grid3.max) tiles.push(el('li', { className: 'tile empty' }));
  return el('ol', { className: 'grid3', ariaLabel: '3x3' }, ...tiles);
}

// ---- drag to reorder ------------------------------------------------------------------------

const HOLD_MS = 220; // touch and pen: press and hold before a drag starts, so the page can still scroll
const MOVE_PX = 5; // mouse: how far to move before a press becomes a drag
const SLOP_PX = 10; // touch: moving this far before the hold ends means the user is scrolling

// Makes the picks in `list` draggable. While dragging, a copy follows the pointer and the pick
// it would land on is outlined; the order only changes on drop.
function makeSortable(list, reorder) {
  let press = null;
  const picks = () => [...list.querySelectorAll('[data-index]')];

  const targetAt = (x, y) => {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const n of picks()) {
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(n.dataset.index);
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = n;
      }
    }
    return nearest ? Number(nearest.dataset.index) : null;
  };

  const update = () => {
    if (!press?.ghost) return;
    press.ghost.style.left = `${press.x - press.offX}px`;
    press.ghost.style.top = `${press.y - press.offY}px`;
    press.to = targetAt(press.x, press.y);
    for (const n of picks()) n.classList.toggle('drop-target', Number(n.dataset.index) === press.to && press.to !== press.from);
    press.scroll = press.y < 70 ? -1 : press.y > window.innerHeight - 70 ? 1 : 0; // scroll near the screen edge
  };

  const loop = () => {
    if (!press?.ghost) return;
    if (press.scroll) {
      window.scrollBy(0, press.scroll * 14);
      update();
    }
    press.raf = requestAnimationFrame(loop);
  };

  const begin = () => {
    const r = press.li.getBoundingClientRect();
    press.offX = press.startX - r.left;
    press.offY = press.startY - r.top;
    // the copy sits in a bare clone of the list so it keeps the list's styles
    const ghost = list.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.classList.add('drag-ghost');
    const copy = press.li.cloneNode(true);
    copy.removeAttribute('data-index');
    copy.removeAttribute('tabindex');
    ghost.append(copy);
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    press.ghost = ghost;
    press.li.classList.add('drag-source');
    document.body.classList.add('is-dragging');
    update();
    loop();
  };

  const finish = (commit) => {
    const { from, to } = press;
    clearTimeout(press.timer);
    cancelAnimationFrame(press.raf);
    press.ghost?.remove();
    press.li.classList.remove('drag-source');
    for (const n of picks()) n.classList.remove('drop-target');
    document.body.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey);
    const dragged = Boolean(press.ghost);
    press = null;
    if (commit && dragged && to != null && to !== from) reorder(from, to);
  };

  const onMove = (ev) => {
    if (!press || ev.pointerId !== press.pointerId) return;
    press.x = ev.clientX;
    press.y = ev.clientY;
    if (press.ghost) return update();
    const moved = Math.hypot(press.x - press.startX, press.y - press.startY);
    if (press.touchLike && moved > SLOP_PX) finish(false); // the finger is scrolling, not dragging
    else if (!press.touchLike && moved > MOVE_PX) begin();
  };
  const onUp = (ev) => press && ev.pointerId === press.pointerId && finish(true);
  const onCancel = (ev) => press && ev.pointerId === press.pointerId && finish(false);
  const onKey = (ev) => ev.key === 'Escape' && press && finish(false);

  list.addEventListener('pointerdown', (ev) => {
    const li = ev.target.closest('[data-index]');
    if (press || !li || ev.target.closest('button') || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const touchLike = ev.pointerType !== 'mouse';
    press = { li, from: Number(li.dataset.index), to: null, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, touchLike, ghost: null, raf: 0, scroll: 0 };
    if (touchLike) press.timer = setTimeout(() => press && !press.ghost && begin(), HOLD_MS);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  });

  // once a drag is live, keep the page from scrolling or selecting text under the finger
  list.addEventListener('touchmove', (ev) => press?.ghost && ev.preventDefault(), { passive: false });
  list.addEventListener('selectstart', (ev) => press && ev.preventDefault());
  list.addEventListener('contextmenu', (ev) => press && ev.preventDefault());
}

// ---- editor ---------------------------------------------------------------------------------

function setKind(kind) {
  draft.kind = kind;
  const { max } = KINDS[kind];
  if (draft.items.length > max) {
    draft.items.length = max;
    say(`Trimmed to ${max}.`);
  }
  for (const k of Object.keys(KINDS)) $(`kind-${k}`).setAttribute('aria-pressed', String(k === kind));
  renderDraft();
}

function renderDraft() {
  const { kind, items } = draft;
  $('count').textContent = `(${items.length} / ${KINDS[kind].max})`;
  const empty = !items.length && kind === 'top10';
  let list = null;
  if (!empty) {
    list = renderList(kind, items, { reorder, remove });
    makeSortable(list, reorder);
  }
  $('preview').replaceChildren(list ?? el('p', { className: 'muted', textContent: 'No picks yet.' }));
  $('save-list').disabled = !items.length;
  renderPicker();
}

// Moves the pick at `from` so it ends up at `to`, shifting the ones in between.
function reorder(from, to, keepFocus = false) {
  if (from === to || to < 0 || to >= draft.items.length) return;
  const [moved] = draft.items.splice(from, 1);
  draft.items.splice(to, 0, moved);
  renderDraft();
  if (keepFocus) $('preview').querySelector(`[data-index="${to}"]`)?.focus();
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
      ? 'No matches.'
      : 'Library is empty.'
    : `${PICKER_LIMIT} of ${matches.length}`;
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
  if (!title) return say('Add a title.');
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
  say('Saved.');
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
  $('mine-empty').textContent = 'No lists yet.';
  $('others-empty').hidden = others.length > 0;
  $('list-count').textContent = `${lists.length} ${lists.length === 1 ? 'list' : 'lists'}`;
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
      el('p', { textContent: error ? `Could not load this list: ${error.message}` : 'List not found.' }),
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
{
  const local = (session.user.email ?? '').split('@')[0];
  $('handle').textContent = local ? `@${local}` : '';
}
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
