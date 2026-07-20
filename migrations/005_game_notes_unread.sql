-- Migration: Unread notes counts for game boards
--
-- Board notes are discussions with resource_type='game_board' and
-- resource_id='<analysis_id>:<board_id>'. Returns, per board of the
-- given deal set, how many messages from other users are newer than
-- the caller's last_read_at (same logic as get_unread_document_ids).

create or replace function get_game_notes_unread(p_analysis_id uuid)
returns table(resource_id text, unread_count bigint)
language sql stable security definer
as $$
  select d.resource_id, count(dm.id)::bigint
  from discussions d
  join discussion_messages dm on dm.discussion_id = d.id
    and dm.deleted = false
    and dm.user_id != auth.uid()
  left join discussion_read_status drs on drs.discussion_id = d.id
    and drs.user_id = auth.uid()
  where d.resource_type = 'game_board'
    and d.resource_id like p_analysis_id::text || ':%'
    and (drs.last_read_at is null or dm.created_at > drs.last_read_at)
  group by d.resource_id;
$$;
