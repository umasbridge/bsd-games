-- Migration: Per-user tournament visibility
--
-- The Create Deal Set picker is personalized: a user sees only
-- tournaments they retrieved. Retrieving a URL that already exists in
-- the DB skips the scrape and just grants visibility. Backfill: the
-- retriever (created_by), everyone with a deal set on the tournament,
-- and umasbridge (who did the historical club retrieves).

create table if not exists bg_tournament_visibility (
  tournament_id uuid not null references bg_tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

alter table bg_tournament_visibility enable row level security;

create policy "Users read own visibility"
  on bg_tournament_visibility for select using (auth.uid() = user_id);
create policy "Users grant themselves visibility"
  on bg_tournament_visibility for insert with check (auth.uid() = user_id);
create policy "Users remove own visibility"
  on bg_tournament_visibility for delete using (auth.uid() = user_id);

insert into bg_tournament_visibility (tournament_id, user_id)
  select id, created_by from bg_tournaments where created_by is not null
  on conflict do nothing;

insert into bg_tournament_visibility (tournament_id, user_id)
  select distinct e.tournament_id, a.user_id
  from bsd_game_analyses a join bg_events e on e.id = a.event_id
  on conflict do nothing;

insert into bg_tournament_visibility (tournament_id, user_id)
  select id, 'bfe92cae-3e6e-4078-8342-86ee8dfeb754' from bg_tournaments
  where source_format != 'bbo' or created_by = 'bfe92cae-3e6e-4078-8342-86ee8dfeb754'
  on conflict do nothing;
