-- Migration: Enforce RLS on bsd_game_analyses
--
-- RLS was disabled on the table, so every authenticated user could read
-- all deal sets despite the policies existing. Also tighten the INSERT
-- policy (was: user_id is not null — allowed inserting as anyone).

alter table bsd_game_analyses enable row level security;

drop policy "Users can insert analyses" on bsd_game_analyses;
create policy "Users can insert analyses"
  on bsd_game_analyses for insert with check (auth.uid() = user_id);
