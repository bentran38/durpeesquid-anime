# Anime Tracker

Personal anime tracker for DurpeeSquid, served at `anime.durpeesquid.com`.
Static site (no framework), same Supabase project and shared login as
[durpeesquid](https://github.com/bentran38/durpeesquid): `site/app.js` imports
`https://www.durpeesquid.com/auth.js`, so the cookie session carries over.

- Metadata: [AniList](https://anilist.co) (GraphQL, no key), called from the `media-search` Edge Function.
- Stored per title: title, directors, studios, release date, episode count + minutes per episode (or movie runtime),
  status, episodes watched, rewatch count, started and finished dates, rating (0.5 to 10 in half steps), notes.
- Import: on MyAnimeList use Profile > List Settings > Export My List, then pick the file under "Import from MyAnimeList".
  Titles are matched on AniList by MAL id (`media-search` action `bulk`); status, progress, score, dates, rewatches and
  comments carry over, and titles already in the library are skipped.
- Top lists: `/lists` builds a Top 10 or a 3x3 from the library and saves it to `anime.shared_lists` as a snapshot of the
  picks. Every signed-in anime user can open any list (RLS: `project_access` for `anime`); only the owner can edit or delete.
  Migration: `supabase/migrations/20261014010000_shared_lists.sql`.
- Time watched = first pass (all of it if completed, else episodes watched) + rewatches x one full watch-through.

## One-time setup

1. **Migration:** apply `supabase/migrations/20261014000000_tracker_entries.sql` to the shared Supabase project. It creates the `anime` schema; add `anime` under Settings > API > Exposed schemas.
2. **Project row:** add an `anime` project in the admin dashboard (slug `anime`, url `https://anime.durpeesquid.com`)
   and give your user access. The table's RLS and the Edge Function both require `project_access` for slug `anime`.
3. **Deploy the function** with JWT verification off (it checks the caller itself, like the admin function):
   `supabase functions deploy media-search --no-verify-jwt`
4. **Vercel:** import this repo, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as the
   main site). Add `anime.durpeesquid.com` as a domain and a CNAME in Cloudflare.

Vercel preview URLs are not in the Edge Function's CORS allow-list; edit `allowedOrigin` in
`supabase/functions/media-search/index.ts` if you want to use them.

## Local dev

`npm run dev` (needs `.env.local` with the two Supabase vars). Login lives on durpeesquid.com and the session
cookie is not shared with `localhost`, so signing in locally does not work out of the box; test on a deployed preview
or the real subdomain.
