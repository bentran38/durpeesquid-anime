// Metadata lookup for the anime tracker: AniList (GraphQL, no key). Runs server-side so
// the browser never talks to AniList directly.
// verify_jwt is off at the gateway; the checks below verify the caller on every call.
//
//   POST { action: 'search',  source: 'anilist', q: string }
//   POST { action: 'details', source: 'anilist', id: string }
//   POST { action: 'bulk',    source: 'anilist', mal_ids: number[] }  (up to 20, for the MAL import)
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROJECT_SLUG = 'anime';
const allowedOrigin = (o: string) =>
  o === 'https://anime.durpeesquid.com' || /^http:\/\/localhost:\d+$/.test(o);

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, retries = 2): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }).catch((e) => {
    throw new Error(`${new URL(url).host} did not respond (${e?.name === 'TimeoutError' ? 'timed out' : e})`);
  });
  if (res.status === 429 && retries > 0) {
    await sleep(1200);
    return getJson(url, init, retries - 1);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

// ---- AniList --------------------------------------------------------------------------------

const ANILIST = 'https://graphql.anilist.co';

async function anilist(query: string, variables: Record<string, unknown>) {
  const j = await getJson(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (j.errors?.length) throw new Error(`AniList: ${j.errors[0].message}`);
  return j.data;
}

const titleOf = (m: any) => m.title?.english || m.title?.romaji || m.title?.native || 'Untitled';
const FORMAT_LABEL: Record<string, string> = {
  TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music',
};

async function anilistSearch(q: string) {
  const data = await anilist(
    `query ($q: String) {
      Page(perPage: 12) {
        media(search: $q, type: ANIME, sort: POPULARITY_DESC) {
          id title { english romaji native } format episodes startDate { year } coverImage { large }
        }
      }
    }`,
    { q },
  );
  return (data.Page?.media ?? []).map((m: any) => ({
    source: 'anilist',
    source_id: String(m.id),
    title: titleOf(m),
    type: FORMAT_LABEL[m.format] ?? m.format ?? null,
    year: m.startDate?.year ?? null,
    episodes: m.episodes ?? null,
    poster_url: m.coverImage?.large ?? null,
  }));
}

const MEDIA_FIELDS = `
  id idMal title { english romaji native } format episodes duration
  startDate { year month day } coverImage { extraLarge large }
  studios(isMain: true) { nodes { name } }
  staff(sort: RELEVANCE, perPage: 25) { edges { role node { name { full } } } }`;

async function anilistDetails(id: string) {
  if (!/^\d+$/.test(id)) throw new Error('Bad id');
  const { Media } = await anilist(`query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`, {
    id: Number(id),
  });
  return toEntry(Media);
}

// Looks up several MyAnimeList ids at once (for importing a MAL export). Ids AniList does not
// know come back in `missing`.
async function anilistByMalIds(ids: number[]) {
  const data = await anilist(
    `query ($ids: [Int], $n: Int) { Page(perPage: $n) { media(idMal_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
    { ids, n: ids.length },
  );
  const found = new Map<number, any>((data.Page?.media ?? []).map((m: any) => [m.idMal, m]));
  return {
    matches: ids.filter((id) => found.has(id)).map((id) => ({ mal_id: id, entry: toEntry(found.get(id)) })),
    missing: ids.filter((id) => !found.has(id)),
  };
}

function toEntry(m: any) {
  const isMovie = m.format === 'MOVIE';
  const { year, month, day } = m.startDate ?? {};
  const pad = (n: number) => String(n).padStart(2, '0');
  const directors = (m.staff?.edges ?? [])
    .filter((e: any) => /^(chief |series )?director$/i.test(e.role ?? ''))
    .map((e: any) => e.node?.name?.full)
    .filter(Boolean);
  return {
    source: 'anilist',
    source_id: String(m.id),
    kind: isMovie ? 'movie' : 'series',
    title: titleOf(m),
    directors: [...new Set(directors)],
    studios: (m.studios?.nodes ?? []).map((n: any) => n.name),
    release_date: year ? `${year}-${pad(month ?? 1)}-${pad(day ?? 1)}` : null,
    episodes: isMovie ? null : m.episodes ?? null,
    episode_minutes: isMovie ? null : m.duration ?? null,
    runtime_minutes: isMovie ? m.duration ?? null : null,
    poster_url: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
  };
}

// ---- handler --------------------------------------------------------------------------------

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (allowedOrigin(origin)) cors['Access-Control-Allow-Origin'] = origin;

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  if (!token) return reply(401, { error: 'Not signed in' });
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return reply(401, { error: 'Not signed in' });
  const { data: access, error: accessErr } = await db
    .from('project_access')
    .select('project_slug')
    .eq('user_id', auth.user.id)
    .eq('project_slug', PROJECT_SLUG)
    .maybeSingle();
  if (accessErr) return reply(500, { error: 'Could not check access' });
  if (!access) return reply(403, { error: 'No access to this project' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Invalid JSON' });
  }
  const { action, source } = body;
  if (source !== 'anilist') return reply(400, { error: 'Unknown source' });

  try {
    if (action === 'search') {
      const q = typeof body.q === 'string' ? body.q.trim().slice(0, 100) : '';
      if (q.length < 2) return reply(400, { error: 'Search needs at least 2 characters' });
      return reply(200, { results: await anilistSearch(q) });
    }
    if (action === 'bulk') {
      const ids = Array.isArray(body.mal_ids) ? body.mal_ids : [];
      if (!ids.length || ids.length > 20 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
        return reply(400, { error: 'Send 1 to 20 MyAnimeList ids' });
      }
      return reply(200, await anilistByMalIds(ids as number[]));
    }
    if (action === 'details') {
      const id = String(body.id ?? '');
      return reply(200, { entry: await anilistDetails(id) });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    return reply(502, { error: 'Lookup failed', detail: e instanceof Error ? e.message : String(e) });
  }
});
