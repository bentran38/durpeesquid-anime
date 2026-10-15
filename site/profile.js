// A person's public page (/u/<handle>): their Top 10, their 3x3 and their whole library. Each of
// those only appears if its owner made it public; the owner always sees all of their own.
import { supabase, requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import { $, el, poster, renderList } from './render.js';
import { STATUSES, STATUS_LABEL, minutesWatched, fmtDuration } from './stats.js';

const SLUG = 'anime';
const db = supabase.schema('anime');

const session = await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}
const me = session.user.id;

$('app').hidden = false;
$('signout').onclick = signOut;
$('home-link').href = HOME;
{
  const local = (session.user.email ?? '').split('@')[0];
  $('handle').textContent = local ? `@${local}` : '';
  loadProfile(me).then((p) => p?.handle && ($('handle').textContent = `@${p.handle}`));
}

// /u/<handle> in production; ?u=<handle> works too.
const wanted = (location.pathname.match(/^\/u\/([^/]+)/)?.[1] ?? new URLSearchParams(location.search).get('u') ?? '').toLowerCase();
const { data: profile } = wanted
  ? await supabase.from('profiles').select('user_id, handle, display_name').eq('handle', decodeURIComponent(wanted)).maybeSingle()
  : { data: null };

if (!profile) {
  $('not-found').hidden = false;
} else {
  await showProfile(profile);
}

async function showProfile(p) {
  const isMe = p.user_id === me;
  const name = p.display_name || `@${p.handle}`;
  document.title = `${name} · Anime`;
  $('content').hidden = false;
  $('profile-name').textContent = name;
  $('avatar').textContent = name.replace('@', '').charAt(0).toUpperCase();
  $('eyebrow').textContent = isMe ? `You · @${p.handle}` : `@${p.handle}`;

  const [listsResult, settingsResult] = await Promise.all([
    db.from('shared_lists').select('*').eq('user_id', p.user_id),
    db.from('profile_settings').select('library_public').eq('user_id', p.user_id).maybeSingle(),
  ]);

  let anything = false;
  for (const list of listsResult.data ?? []) {
    // Other people only receive public lists (the database enforces it); the tag is for the owner.
    $(`sec-${list.kind}`).hidden = false;
    $(`tag-${list.kind}`).textContent = isMe ? (list.is_public ? 'Public' : 'Private') : '';
    $(`tag-${list.kind}`).hidden = !isMe;
    const heading = $(`sec-${list.kind}`).querySelector('h2');
    heading.textContent = list.title;
    $(`list-${list.kind}`).replaceChildren(renderList(list.kind, list.items));
    anything = true;
  }

  const libraryPublic = Boolean(settingsResult.data?.library_public);
  if (isMe || libraryPublic) {
    const { data } = isMe
      ? await db.from('tracker_entries').select('*')
      : await db.from('public_entries').select('*').eq('user_id', p.user_id);
    if (data?.length) {
      showLibrary(data, isMe ? (libraryPublic ? 'Public' : 'Private') : '');
      anything = true;
    }
  }
  $('nothing').hidden = anything;
}

// ---- library ----------------------------------------------------------------------------------

function showLibrary(entries, tag) {
  $('sec-library').hidden = false;
  $('tag-library').textContent = tag;
  $('tag-library').hidden = !tag;

  const rated = entries.filter((e) => e.rating != null);
  const avg = rated.length ? (rated.reduce((s, e) => s + Number(e.rating), 0) / rated.length).toFixed(2) : '–';
  const total = entries.reduce((s, e) => s + minutesWatched(e), 0);
  const cell = (label, value) => el('div', { className: 'stat-cell' }, el('span', { className: 'stat-label', textContent: label }), el('span', { className: 'stat-value', textContent: value }));
  $('stats').replaceChildren(
    cell('Titles', String(entries.length)),
    cell('Completed', String(entries.filter((e) => e.status === 'completed').length)),
    cell('Time watched', fmtDuration(total)),
    cell('Avg rating', avg),
  );
  $('stats').hidden = false;

  let status = '';
  const counts = Object.fromEntries(STATUSES.map(([v]) => [v, entries.filter((e) => e.status === v).length]));
  const chips = [['', `All ${entries.length}`], ...STATUSES.filter(([v]) => counts[v]).map(([v, label]) => [v, `${label} ${counts[v]}`])];
  const SORTS = {
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.title.localeCompare(b.title),
    recent: (a, b) => b.created_at.localeCompare(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title),
  };

  const draw = () => {
    const q = $('wall-search').value.trim().toLowerCase();
    const shown = entries.filter((e) => (!status || e.status === status) && (!q || e.title.toLowerCase().includes(q))).sort(SORTS[$('wall-sort').value]);
    $('wall').replaceChildren(
      ...shown.map((e) =>
        el(
          'li',
          { className: 'wall-card', title: e.title },
          el('div', { className: 'wall-poster' }, poster(e.poster_url, 'cover'), e.rating != null && el('span', { className: 'star', textContent: `★ ${Number(e.rating).toFixed(1)}` })),
          el('div', { className: 'wall-info' }, el('span', { className: 'wall-title', textContent: e.title }), el('span', { className: 'pill', textContent: STATUS_LABEL[e.status] })),
        ),
      ),
    );
    for (const [i, li] of [...$('wall').children].entries()) li.dataset.status = shown[i].status;
  };

  $('wall-chips').replaceChildren(
    ...chips.map(([value, label]) => {
      const chip = el('button', { type: 'button', className: 'chip', textContent: label });
      chip.setAttribute('aria-pressed', String(value === status));
      chip.onclick = () => {
        status = value;
        for (const c of $('wall-chips').children) c.setAttribute('aria-pressed', String(c === chip));
        draw();
      };
      return chip;
    }),
  );
  $('wall-search').oninput = draw;
  $('wall-sort').onchange = draw;
  draw();
}
