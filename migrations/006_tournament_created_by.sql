-- Migration: Track who retrieved a tournament
--
-- Club tournaments (bridgewebs/srini/lovebridge) are shared reference
-- data, but BBO retrieves are personal sessions — they should only
-- appear in the retriever's Create Deal Set picker. Backfill existing
-- BBO tournaments from the earliest deal set created on their events.

alter table bg_tournaments add column if not exists created_by uuid references auth.users(id);

update bg_tournaments t
set created_by = sub.uid
from (
  select e.tournament_id, (array_agg(a.user_id order by a.created_at))[1] as uid
  from bsd_game_analyses a
  join bg_events e on e.id = a.event_id
  group by e.tournament_id
) sub
where sub.tournament_id = t.id
  and t.source_format = 'bbo'
  and t.created_by is null;

-- Remaining BBO tournaments with no deal set: retrieved by umasbridge
update bg_tournaments
set created_by = 'bfe92cae-3e6e-4078-8342-86ee8dfeb754'
where source_format = 'bbo' and created_by is null;
