// My Lists: each person has one Top 10 and one 3x3, built from their tracker library. Each list is
// private (only its owner) or public (shown on their page to other signed-in anime users).
import { supabase, requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import { $, el, poster, KINDS, itemFrom, meta, renderList } from './render.js';
import { makeSortable } from './sortable.js';

const SLUG = 'anime';
const db = supabase.schema('anime');

let me = null; // signed-in user id
let library = []; // tracker entries offered in the picker
let kind = 'top10'; // which list the editor is showing

// One draft per kind. Switching between them keeps unsaved edits.
const blank = () => ({ id: null, title: '', items: [], is_public: false });
const drafts = { top10: blank(), grid3: blank() };
const draft = () => drafts[kind];

let toastTimer;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2400);
}
const say = (text) => ($('editor-msg').textContent = text);

// ---- editor -----------------------------------------------------------------------------------

function setKind(next) {
  kind = next;
  for (const k of Object.keys(KINDS)) $(`kind-${k}`).setAttribute('aria-pressed', String(k === kind));
  $('list-title').value = draft().title;
  $('list-title').placeholder = KINDS[kind].label;
  say('');
  renderDraft();
}

function renderDraft() {
  const { items, is_public: isPublic, id } = draft();
  $('count').textContent = `(${items.length} / ${KINDS[kind].max})`;
  $('vis-private').setAttribute('aria-pressed', String(!isPublic));
  $('vis-public').setAttribute('aria-pressed', String(isPublic));
  $('delete-list').hidden = !id;

  let list = null;
  if (items.length || kind === 'grid3') {
    list = renderList(kind, items, { reorder, remove });
    makeSortable(list, reorder);
  }
  $('preview').replaceChildren(list ?? el('p', { className: 'muted', textContent: 'No picks yet.' }));
  $('save-list').disabled = !items.length;
  renderPicker();
}

// Moves the pick at `from` so it ends up at `to`, shifting the ones in between.
function reorder(from, to, keepFocus = false) {
  const { items } = draft();
  if (from === to || to < 0 || to >= items.length) return;
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  renderDraft();
  if (keepFocus) $('preview').querySelector(`[data-index="${to}"]`)?.focus();
}

function remove(i) {
  draft().items.splice(i, 1);
  renderDraft();
}

function add(entry) {
  const { items } = draft();
  if (items.length >= KINDS[kind].max || items.some((it) => it.source_id === entry.source_id)) return;
  items.push(itemFrom(entry));
  say('');
  renderDraft();
}

const PICKER_LIMIT = 60;

function renderPicker() {
  const q = $('pick-filter').value.trim().toLowerCase();
  const taken = new Set(draft().items.map((it) => it.source_id));
  const full = draft().items.length >= KINDS[kind].max;
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
  note.textContent = !matches.length ? (library.length ? 'No matches.' : 'Library is empty.') : `${PICKER_LIMIT} of ${matches.length}`;
}

async function save() {
  const d = draft();
  const title = $('list-title').value.trim() || KINDS[kind].label;
  $('save-list').disabled = true;
  say('Saving…');
  // One list per kind: the unique (user, kind) pair makes this an update when one already exists.
  const { data, error } = await db
    .from('shared_lists')
    .upsert({ kind, title, items: d.items, is_public: d.is_public }, { onConflict: 'user_id,kind' })
    .select()
    .single();
  $('save-list').disabled = false;
  if (error) return say(`Could not save: ${error.message}`);
  Object.assign(d, { id: data.id, title: data.title });
  $('list-title').value = data.title;
  say('');
  toast(`${KINDS[kind].label} saved${d.is_public ? ' · public' : ' · private'}`);
  renderDraft();
  updateCount();
}

async function setVisibility(isPublic) {
  const d = draft();
  if (d.is_public === isPublic) return;
  d.is_public = isPublic;
  renderDraft();
  if (!d.id) return; // not saved yet: it takes effect when the list is saved
  // The list already exists, so the change applies straight away.
  const { error } = await db.from('shared_lists').update({ is_public: isPublic }).eq('id', d.id);
  if (error) {
    d.is_public = !isPublic;
    renderDraft();
    return toast(`Could not change visibility: ${error.message}`, true);
  }
  toast(isPublic ? `${KINDS[kind].label} is now public` : `${KINDS[kind].label} is now private`);
}

async function deleteList() {
  const d = draft();
  if (!d.id || !confirm(`Delete your ${KINDS[kind].label}?`)) return;
  const { error } = await db.from('shared_lists').delete().eq('id', d.id);
  if (error) return toast(`Could not delete: ${error.message}`, true);
  drafts[kind] = blank();
  setKind(kind);
  updateCount();
  toast(`${KINDS[kind].label} deleted`);
}

function updateCount() {
  const saved = Object.values(drafts).filter((d) => d.id).length;
  $('list-count').textContent = `${saved} of 2 lists saved`;
}

// ---- people with public pages -----------------------------------------------------------------

async function loadPeople() {
  const [lists, libs] = await Promise.all([
    db.from('shared_lists').select('user_id').eq('is_public', true),
    db.from('profile_settings').select('user_id').eq('library_public', true),
  ]);
  const ids = [...new Set([...(lists.data ?? []), ...(libs.data ?? [])].map((r) => r.user_id))].filter((id) => id !== me);
  let people = [];
  if (ids.length) {
    const { data } = await supabase.from('profiles').select('user_id, handle, display_name').in('user_id', ids);
    people = (data ?? []).filter((p) => p.handle);
  }
  $('people').replaceChildren(
    ...people.map((p) =>
      el(
        'li',
        {},
        el(
          'a',
          { className: 'person-link', href: `/u/${p.handle}` },
          el('span', { className: 'avatar', textContent: (p.display_name || p.handle).charAt(0).toUpperCase() }),
          el('span', { className: 'info' }, el('span', { textContent: p.display_name || p.handle }), el('small', { textContent: `@${p.handle}` })),
        ),
      ),
    ),
  );
  $('people-empty').hidden = people.length > 0;
}

// ---- start ------------------------------------------------------------------------------------

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
  loadProfile(me).then((profile) => {
    if (!profile?.handle) return;
    $('handle').textContent = `@${profile.handle}`;
    $('page-link').href = `/u/${profile.handle}`;
    $('page-link').hidden = false;
  });
}

$('kind-top10').onclick = () => setKind('top10');
$('kind-grid3').onclick = () => setKind('grid3');
$('vis-private').onclick = () => setVisibility(false);
$('vis-public').onclick = () => setVisibility(true);
$('list-title').oninput = () => (draft().title = $('list-title').value);
$('pick-filter').oninput = renderPicker;
$('save-list').onclick = save;
$('delete-list').onclick = deleteList;

const [libraryResult, listsResult] = await Promise.all([
  db.from('tracker_entries').select('source_id, title, poster_url, rating, release_date'),
  db.from('shared_lists').select('*').eq('user_id', me),
  loadPeople(),
]);
library = libraryResult.data ?? [];
if (libraryResult.error) say(`Could not load your library: ${libraryResult.error.message}`);
for (const row of listsResult.data ?? []) {
  drafts[row.kind] = { id: row.id, title: row.title, items: row.items, is_public: row.is_public };
}
updateCount();
setKind('top10');
