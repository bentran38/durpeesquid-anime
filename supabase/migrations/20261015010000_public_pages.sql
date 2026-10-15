-- Public pages: each user has at most one Top 10 and one 3x3, each either private (owner only) or
-- public (every signed-in anime user can read it), and can make their whole library public.
-- Handles and names come from public.profiles (see the main dashboard's migrations).

-- one list per kind per person
alter table anime.shared_lists add column is_public boolean not null default false;
alter table anime.shared_lists add constraint shared_lists_one_per_kind unique (user_id, kind);

-- readers see only public lists; owners already see their own through the "manage own lists" policy
drop policy "anime users read all lists" on anime.shared_lists;
create policy "anime users read public lists"
  on anime.shared_lists for select to authenticated
  using (
    is_public
    and exists (
      select 1 from public.project_access a
      where a.user_id = (select auth.uid()) and a.project_slug = 'anime'
    )
  );

-- whether a person's whole library is visible to others
create table anime.profile_settings (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  library_public boolean not null default false,
  updated_at     timestamptz not null default now()
);

create trigger profile_settings_touch
  before update on anime.profile_settings
  for each row execute function anime.tracker_touch();

alter table anime.profile_settings enable row level security;
revoke all on anime.profile_settings from anon, authenticated;
grant select, insert, update on anime.profile_settings to authenticated;
grant all on anime.profile_settings to service_role;

create policy "manage own settings"
  on anime.profile_settings for all to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.project_access a where a.user_id = (select auth.uid()) and a.project_slug = 'anime')
  )
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.project_access a where a.user_id = (select auth.uid()) and a.project_slug = 'anime')
  );

create policy "anime users read public flags"
  on anime.profile_settings for select to authenticated
  using (
    library_public
    and exists (select 1 from public.project_access a where a.user_id = (select auth.uid()) and a.project_slug = 'anime')
  );

-- Other people's libraries are read through this view, never the table: it leaves out notes, only
-- returns libraries their owner made public, and only for signed-in anime users. It runs with its
-- owner's rights on purpose (the table's own policy only lets owners read their rows).
create view anime.public_entries as
  select e.id, e.user_id, e.source_id, e.kind, e.title, e.directors, e.studios, e.release_date,
         e.episodes, e.episode_minutes, e.runtime_minutes, e.poster_url, e.status,
         e.episodes_watched, e.rewatch_count, e.rating, e.started_on, e.finished_on, e.created_at
  from anime.tracker_entries e
  where exists (select 1 from anime.profile_settings s where s.user_id = e.user_id and s.library_public)
    and exists (select 1 from public.project_access a where a.user_id = auth.uid() and a.project_slug = 'anime');

revoke all on anime.public_entries from anon, authenticated;
grant select on anime.public_entries to authenticated;
grant all on anime.public_entries to service_role;
