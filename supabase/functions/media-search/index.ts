// Metadata lookup for the anime tracker: Jikan (MyAnimeList data, no key) for anime, TMDB for movies.
// Runs server-side so the TMDB token never reaches the browser and Jikan's rate limit is shared.
// verify_jwt is off at the gateway; the checks below verify the caller on every call.
//
//   POST { action: 'search',  source: 'jikan' | 'tmdb', q: string }
//   POST { action: 'details', source: 'jikan' | 'tmdb', id: string }
//
// Secret: TMDB_READ_TOKEN (TMDB "API Read Access Token").
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROJECT_SLUG = 'anime';
const allowedOrigin = (o: string) =>
  o === 'https://anime.durpeesquid.com' || /^http:\/\/localhost:\d+$/.test(o);

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, retries = 2): Promise<any> {
  const res = await fetch(url, init);
  if (res.status === 429 && retries > 0) {
    await sleep(1200);
    return getJson(url, init, retries - 1);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

// "24 min per ep" -> 24, "1 hr 55 min" -> 115
function parseMinutes(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const hr = s.match(/(\d+)\s*hr/i);
  const min = s.match(/(\d+)\s*min/i);
  if (!hr && !min) return null;
  return (hr ? +hr[1] * 60 : 0) + (min ? +min[1] : 0);
}

const dateOnly = (s: unknown) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

// ---- Jikan ----------------------------------------------------------------------------------

const JIKAN = 'https://api.jikan.moe/v4';

async function jikanSearch(q: string) {
  const j = await getJson(`${JIKAN}/anime?q=${encodeURIComponent(q)}&limit=12&order_by=members&sort=desc`);
  return (j.data ?? []).map((a: any) => ({
    source: 'jikan',
    source_id: String(a.mal_id),
    title: a.title_english || a.title,
    type: a.type ?? null,
    year: a.aired?.prop?.from?.year ?? null,
    episodes: a.episodes ?? null,
    poster_url: a.images?.jpg?.image_url ?? null,
  }));
}

async function jikanDetails(id: string) {
  if (!/^\d+$/.test(id)) throw new Error('Bad id');
  const full = (await getJson(`${JIKAN}/anime/${id}/full`)).data;
  await sleep(450); // stay under Jikan's per-second limit
  const staff = (await getJson(`${JIKAN}/anime/${id}/staff`)).data ?? [];
  const directors = staff
    .filter((s: any) => (s.positions ?? []).some((p: string) => /^(chief |series )?director$/i.test(p)))
    .map((s: any) => s.person?.name)
    .filter(Boolean);
  const minutes = parseMinutes(full.duration);
  const isMovie = full.type === 'Movie';
  return {
    source: 'jikan',
    source_id: String(full.mal_id),
    kind: isMovie ? 'movie' : 'series',
    title: full.title_english || full.title,
    directors,
    studios: (full.studios ?? []).map((s: any) => s.name),
    release_date: dateOnly(full.aired?.from),
    episodes: isMovie ? null : full.episodes ?? null,
    episode_minutes: isMovie ? null : minutes,
    runtime_minutes: isMovie ? minutes : null,
    poster_url: full.images?.jpg?.large_image_url ?? full.images?.jpg?.image_url ?? null,
  };
}

// ---- TMDB -----------------------------------------------------------------------------------

const TMDB = 'https://api.themoviedb.org/3';
const tmdbInit = () => {
  const token = Deno.env.get('TMDB_READ_TOKEN');
  if (!token) throw new Error('TMDB_READ_TOKEN is not set');
  return { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
};
const tmdbPoster = (p: string | null) => (p ? `https://image.tmdb.org/t/p/w342${p}` : null);

async function tmdbSearch(q: string) {
  const j = await getJson(`${TMDB}/search/movie?query=${encodeURIComponent(q)}&include_adult=false`, tmdbInit());
  return (j.results ?? []).slice(0, 12).map((m: any) => ({
    source: 'tmdb',
    source_id: String(m.id),
    title: m.title,
    type: 'Movie',
    year: dateOnly(m.release_date)?.slice(0, 4) ?? null,
    episodes: null,
    poster_url: tmdbPoster(m.poster_path),
  }));
}

async function tmdbDetails(id: string) {
  if (!/^\d+$/.test(id)) throw new Error('Bad id');
  const m = await getJson(`${TMDB}/movie/${id}?append_to_response=credits`, tmdbInit());
  return {
    source: 'tmdb',
    source_id: String(m.id),
    kind: 'movie',
    title: m.title,
    directors: (m.credits?.crew ?? []).filter((c: any) => c.job === 'Director').map((c: any) => c.name),
    studios: (m.production_companies ?? []).map((c: any) => c.name),
    release_date: dateOnly(m.release_date),
    episodes: null,
    episode_minutes: null,
    runtime_minutes: m.runtime || null,
    poster_url: tmdbPoster(m.poster_path),
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
  if (source !== 'jikan' && source !== 'tmdb') return reply(400, { error: 'Unknown source' });

  try {
    if (action === 'search') {
      const q = typeof body.q === 'string' ? body.q.trim().slice(0, 100) : '';
      if (q.length < 2) return reply(400, { error: 'Search needs at least 2 characters' });
      return reply(200, { results: await (source === 'jikan' ? jikanSearch(q) : tmdbSearch(q)) });
    }
    if (action === 'details') {
      const id = String(body.id ?? '');
      return reply(200, { entry: await (source === 'jikan' ? jikanDetails(id) : tmdbDetails(id)) });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    return reply(502, { error: 'Lookup failed', detail: e instanceof Error ? e.message : String(e) });
  }
});
