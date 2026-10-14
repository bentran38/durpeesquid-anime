-- Personal anime/movie tracker. One row per user per title; metadata is copied from Jikan / TMDB
-- when a title is added so the library works without calling those APIs again.
-- Only users with access to the 'anime' project (public.project_access) can touch their rows.

-- Everything for this project lives in its own schema, separate from the main dashboard's `public`.
-- The schema must also be listed under Settings > API > Exposed schemas so the client can reach it.
create schema if not exists anime;
grant usage on schema anime to authenticated, service_role;

create table anime.tracker_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,

  source           text not null check (source in ('jikan', 'tmdb')),
  source_id        text not null,
  kind             text not null check (kind in ('series', 'movie')),
  title            text not null,
  directors        text[] not null default '{}',
  studios          text[] not null default '{}',
  release_date     date,
  episodes         int  check (episodes >= 0),          -- null while a series is still airing
  episode_minutes  int  check (episode_minutes >= 0),   -- per episode (series)
  runtime_minutes  int  check (runtime_minutes >= 0),   -- whole film (movie)
  poster_url       text,

  status           text not null default 'planned'
                   check (status in ('planned', 'watching', 'completed', 'on_hold', 'dropped')),
  episodes_watched int  not null default 0 check (episodes_watched >= 0),
  rewatch_count    int  not null default 0 check (rewatch_count >= 0),
  -- 0.5 to 10 in half-point steps (1.5, 2.5, ...); null = unrated
  rating           numeric(3, 1) check (rating >= 0.5 and rating <= 10 and rating * 2 = trunc(rating * 2)),
  notes            text not null default '',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, source, source_id)
);

create index tracker_entries_user_idx on anime.tracker_entries (user_id);

create function anime.tracker_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger tracker_entries_touch
  before update on anime.tracker_entries
  for each row execute function anime.tracker_touch();

alter table anime.tracker_entries enable row level security;

revoke all on anime.tracker_entries from anon, authenticated;
grant select, insert, update, delete on anime.tracker_entries to authenticated;
grant all on anime.tracker_entries to service_role;

create policy "manage own tracker entries"
  on anime.tracker_entries for all to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.project_access a
      where a.user_id = (select auth.uid()) and a.project_slug = 'anime'
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.project_access a
      where a.user_id = (select auth.uid()) and a.project_slug = 'anime'
    )
  );
