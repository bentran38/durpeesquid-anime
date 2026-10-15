-- Shareable "Top 10" and "3x3" lists. A list stores a snapshot of its picks (title, poster, rating)
-- so other users can see it without being able to read the owner's tracker_entries.
-- Any signed-in user with access to the 'anime' project can read every list; only the owner can change one.

create table anime.shared_lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,

  kind        text not null check (kind in ('top10', 'grid3')),
  title       text not null check (char_length(title) between 1 and 80),
  author_name text not null default '' check (char_length(author_name) <= 40),
  -- [{ source_id, title, poster_url, rating, year }, ...] in display order
  items       jsonb not null check (
    jsonb_typeof(items) = 'array'
    and jsonb_array_length(items) between 1 and 10
  ),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- a 3x3 holds nine picks, a top 10 holds ten
  check (kind <> 'grid3' or jsonb_array_length(items) <= 9)
);

create index shared_lists_user_idx on anime.shared_lists (user_id);
create index shared_lists_created_idx on anime.shared_lists (created_at desc);

create trigger shared_lists_touch
  before update on anime.shared_lists
  for each row execute function anime.tracker_touch();

alter table anime.shared_lists enable row level security;

revoke all on anime.shared_lists from anon, authenticated;
grant select, insert, update, delete on anime.shared_lists to authenticated;
grant all on anime.shared_lists to service_role;

create policy "anime users read all lists"
  on anime.shared_lists for select to authenticated
  using (
    exists (
      select 1 from public.project_access a
      where a.user_id = (select auth.uid()) and a.project_slug = 'anime'
    )
  );

create policy "manage own lists"
  on anime.shared_lists for all to authenticated
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
