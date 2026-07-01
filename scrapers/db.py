"""Supabase client and insert helpers for bg_ tables.

Schema hierarchy: bg_tournaments → bg_events → bg_stages
  - Boards link to stages
  - Participants link to events
  - Results link to boards + stages
"""

import os

def _import_supabase():
    try:
        from supabase import create_client
        return create_client
    except ImportError:
        raise RuntimeError(
            'supabase-py not installed. Run:\n'
            '  pip3 install supabase'
        )

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://fwvbjmntuersvhvqxuxq.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')

_client = None

def get_client():
    global _client
    if _client is None:
        if not SUPABASE_KEY:
            raise RuntimeError(
                'SUPABASE_KEY not set. Export it as an environment variable:\n'
                '  export SUPABASE_KEY="your-service-role-key"'
            )
        create_client = _import_supabase()
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


# ── Tournament ───────────────────────────────────────────────────

def insert_tournament(data: dict) -> str:
    """Insert a tournament row. Returns the tournament id."""
    resp = get_client().table('bg_tournaments').insert(data).execute()
    return resp.data[0]['id']


def find_tournament(name: str, source_format: str):
    """Find existing tournament by name + source_format. Returns row or None."""
    resp = (get_client().table('bg_tournaments')
            .select('*')
            .eq('name', name)
            .eq('source_format', source_format)
            .limit(1)
            .execute())
    return resp.data[0] if resp.data else None


def upsert_tournament(data: dict) -> str:
    """Insert or find existing tournament. Returns id."""
    existing = find_tournament(data['name'], data['source_format'])
    if existing:
        return existing['id']
    return insert_tournament(data)


# ── Event ────────────────────────────────────────────────────────

def insert_event(data: dict) -> str:
    """Insert an event row. Returns the event id."""
    resp = get_client().table('bg_events').insert(data).execute()
    return resp.data[0]['id']


def find_event(tournament_id: str, name: str):
    """Find existing event by tournament + name. Returns row or None."""
    resp = (get_client().table('bg_events')
            .select('*')
            .eq('tournament_id', tournament_id)
            .eq('name', name)
            .limit(1)
            .execute())
    return resp.data[0] if resp.data else None


def upsert_event(data: dict) -> str:
    """Insert or find existing event. Returns id."""
    existing = find_event(data['tournament_id'], data['name'])
    if existing:
        return existing['id']
    return insert_event(data)


# ── Stage ────────────────────────────────────────────────────────

def insert_stage(data: dict) -> str:
    """Insert a stage row. Returns the stage id."""
    resp = get_client().table('bg_stages').insert(data).execute()
    return resp.data[0]['id']


def find_stage(event_id: str, name: str):
    """Find existing stage by event + name. Returns row or None."""
    resp = (get_client().table('bg_stages')
            .select('*')
            .eq('event_id', event_id)
            .eq('name', name)
            .limit(1)
            .execute())
    return resp.data[0] if resp.data else None


def upsert_stage(data: dict) -> str:
    """Insert or find existing stage. Returns id."""
    existing = find_stage(data['event_id'], data['name'])
    if existing:
        return existing['id']
    return insert_stage(data)


# ── Participants ─────────────────────────────────────────────────

def insert_participants(rows: list[dict]) -> dict:
    """Insert participant rows. Returns {number: id} mapping."""
    if not rows:
        return {}
    resp = get_client().table('bg_participants').insert(rows).execute()
    return {r['number']: r['id'] for r in resp.data}


def find_participants(event_id: str) -> dict:
    """Find existing participants for an event. Returns {number: id} mapping."""
    resp = (get_client().table('bg_participants')
            .select('id, number')
            .eq('event_id', event_id)
            .execute())
    return {r['number']: r['id'] for r in resp.data}


# ── Boards ───────────────────────────────────────────────────────

def insert_boards(rows: list[dict]) -> dict:
    """Insert board rows. Returns {(round, board_number): id} mapping."""
    if not rows:
        return {}
    batch_size = 100
    all_data = []
    for i in range(0, len(rows), batch_size):
        resp = get_client().table('bg_boards').insert(rows[i:i+batch_size]).execute()
        all_data.extend(resp.data)
    return {(r['round'], r['board_number']): r['id'] for r in all_data}


def update_board_dd(board_id: str, dd: dict):
    """Update a board row with DD data."""
    get_client().table('bg_boards').update(dd).eq('id', board_id).execute()


# ── Board results ────────────────────────────────────────────────

def insert_board_results(rows: list[dict]):
    """Insert board result rows in batches."""
    if not rows:
        return
    batch_size = 100
    for i in range(0, len(rows), batch_size):
        get_client().table('bg_board_results').insert(rows[i:i+batch_size]).execute()


# ── Lookup helpers ───────────────────────────────────────────────

def event_exists(source_url: str) -> bool:
    """Check if an event with this source URL already exists."""
    resp = (get_client().table('bg_events')
            .select('id')
            .eq('source_url', source_url)
            .execute())
    return len(resp.data) > 0


def stage_exists(source_url: str) -> bool:
    """Check if a stage with this source URL already exists."""
    resp = (get_client().table('bg_stages')
            .select('id')
            .eq('source_url', source_url)
            .execute())
    return len(resp.data) > 0


def move_stage_data(source_stage_id: str, target_stage_id: str, target_event_id: str):
    """Move boards and results from source stage to target stage, then clean up source."""
    c = get_client()

    # Move boards
    c.table('bg_boards').update({'stage_id': target_stage_id}).eq('stage_id', source_stage_id).execute()

    # Move results
    c.table('bg_board_results').update({'stage_id': target_stage_id}).eq('stage_id', source_stage_id).execute()

    # Move participants to target event (if not already there)
    source_stage = c.table('bg_stages').select('event_id').eq('id', source_stage_id).single().execute()
    if source_stage.data:
        source_event_id = source_stage.data['event_id']
        if source_event_id != target_event_id:
            source_parts = c.table('bg_participants').select('*').eq('event_id', source_event_id).execute()
            existing = find_participants(target_event_id)
            for p in (source_parts.data or []):
                if p['number'] not in existing:
                    c.table('bg_participants').update({'event_id': target_event_id}).eq('id', p['id']).execute()
                else:
                    # Update result references from old participant to existing one
                    old_id = p['id']
                    new_id = existing[p['number']]
                    c.table('bg_board_results').update({'ns_participant_id': new_id}).eq('ns_participant_id', old_id).eq('stage_id', target_stage_id).execute()
                    c.table('bg_board_results').update({'ew_participant_id': new_id}).eq('ew_participant_id', old_id).eq('stage_id', target_stage_id).execute()
                    c.table('bg_participants').delete().eq('id', old_id).execute()


def cleanup_empty_hierarchy(stage_id: str):
    """Delete a stage and its parent event/tournament if they become empty."""
    c = get_client()
    stage = c.table('bg_stages').select('id, event_id').eq('id', stage_id).single().execute()
    if not stage.data:
        return
    event_id = stage.data['event_id']

    # Delete the empty stage
    c.table('bg_stages').delete().eq('id', stage_id).execute()

    # Check if event is now empty
    remaining = c.table('bg_stages').select('id').eq('event_id', event_id).limit(1).execute()
    if not remaining.data:
        event = c.table('bg_events').select('tournament_id').eq('id', event_id).single().execute()
        tournament_id = event.data['tournament_id'] if event.data else None
        c.table('bg_participants').delete().eq('event_id', event_id).execute()
        c.table('bg_events').delete().eq('id', event_id).execute()

        # Check if tournament is now empty
        if tournament_id:
            remaining_ev = c.table('bg_events').select('id').eq('tournament_id', tournament_id).limit(1).execute()
            if not remaining_ev.data:
                c.table('bg_tournaments').delete().eq('id', tournament_id).execute()
