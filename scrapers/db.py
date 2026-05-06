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
