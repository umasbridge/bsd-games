#!/usr/bin/env python3
"""
Scraper for Srini format (Tournament Calculator by Srinivasan Iyengar).

Scrapes tournament data from sites like bfi.net.in that use Tournament Calculator,
and writes structured data to Supabase bg_ tables.

Usage:
    python3 scrapers/srini.py <tournament_url> [--user-id UUID]

Examples:
    # Teams event
    python3 scrapers/srini.py https://bfi.net.in/wp-content/uploads/2025/eagoldteams/

    # Pairs event
    python3 scrapers/srini.py https://bfi.net.in/wp-content/uploads/2026/vijyajajoomixed/

The URL must point to a single tournament (one settings.json). The scraper validates
this before proceeding.
"""

import argparse
import json
import re
import ssl
import sys
import urllib.request

from utils import (
    SRINI_CARD_MAP, SRINI_DEALER_MAP, SRINI_DECL_MAP, SRINI_DENOM_MAP,
    SRINI_SUIT_MAP, SRINI_VUL_MAP, hand_hcp, contract_display,
)
from lin import generate_lin
from db import (
    insert_tournament, insert_participants, insert_boards,
    insert_board_results, tournament_exists,
)

# SSL workaround for macOS
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


# ── HTTP fetching ─────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ── URL validation ────────────────────────────────────────────────

def validate_url(base_url):
    """Validate that the URL points to a single Srini-format tournament.

    Returns settings dict on success, raises on failure.
    """
    base_url = base_url.rstrip('/')

    # Must be able to fetch settings.json
    try:
        settings = fetch_json(f'{base_url}/settings.json')
    except Exception as e:
        raise ValueError(
            f'Could not fetch settings.json from {base_url}.\n'
            f'Make sure the URL points to a Tournament Calculator tournament root.\n'
            f'Error: {e}'
        )

    # Must have expected fields
    if 'FullName' not in settings and 'BoardsNumbers' not in settings:
        raise ValueError(
            f'URL does not appear to be a Tournament Calculator tournament.\n'
            f'settings.json is missing expected fields (FullName, BoardsNumbers).'
        )

    # Check for multiple stages — that's fine, it's still one tournament
    # But warn if it looks like a container for multiple tournaments
    if settings.get('TournamentType') is None:
        raise ValueError(
            'settings.json has no TournamentType field. '
            'This may not be a valid tournament URL.'
        )

    return settings


# ── Parse tournament metadata ─────────────────────────────────────

def parse_tournament_meta(settings, base_url):
    """Extract tournament metadata from settings.json."""
    name = settings.get('FullName', '').strip() or settings.get('EventName', 'Unknown')

    # Extract date from HtmlHeader
    html_header = settings.get('HtmlHeader', '')
    date_start = None
    date_match = re.search(r'<i>(.*?)</i>', html_header)
    if date_match:
        date_text = date_match.group(1).strip()
        # Try to parse common date formats
        date_start = _parse_date(date_text)

    # Extract venue
    venue = None
    venue_match = re.search(r'<h3[^>]*>(?:<sup></sup>)?(?:&nbsp;|\s)*([^<]+)</h3>', html_header)
    if venue_match:
        venue = re.sub(r'&nbsp;|nbsp;', ' ', venue_match.group(1)).strip()

    # Tournament type
    tt = settings.get('TournamentType', 0)
    tournament_type = 'teams' if tt == 2 else 'pairs'

    # Scoring: teams use IMPs, pairs use matchpoints (TournamentType 0)
    scoring = 'imp' if tt == 2 else 'mp'

    stages = settings.get('AllStages', [])
    source_meta = {
        'stages': stages,
        'td_name': f'{settings.get("TdFirstName", "")} {settings.get("TdLastName", "")}'.strip(),
        'td_email': settings.get('TdEmail', ''),
        'program_version': settings.get('ProgramVersion', ''),
        'boards_count': len(settings.get('BoardsNumbers', [])),
        'rounds': settings.get('LastFinishedRound', 0),
        'tournament_type_raw': tt,
    }

    return {
        'name': name,
        'date_start': date_start,
        'venue': venue,
        'type': tournament_type,
        'scoring': scoring,
        'source_format': 'srini',
        'source_url': base_url,
        'source_meta': source_meta,
    }


def _parse_date(text):
    """Try to parse a date string into YYYY-MM-DD format."""
    import re
    from datetime import datetime

    # Try common formats
    for fmt in ('%d-%m-%Y', '%d/%m/%Y', '%d.%m.%Y', '%B %d, %Y', '%d %B %Y',
                '%d-%b-%Y', '%d %b %Y'):
        try:
            return datetime.strptime(text.strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue

    # Try to find a date-like pattern
    m = re.search(r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})', text)
    if m:
        day, month, year = m.groups()
        return f'{year}-{month.zfill(2)}-{day.zfill(2)}'

    return None


# ── Parse participants ────────────────────────────────────────────

def parse_participants(results_data, tournament_id):
    """Parse teams/pairs from results.json.

    Teams have _people[] array. Pairs have _person1 and _person2 objects.
    """
    rows = []
    for entry in results_data.get('Results', []):
        p = entry.get('Participant', {})
        number = p.get('Number')
        if number is None:
            continue

        roster = []

        # Teams format: _people array
        people = p.get('_people', [])
        if people:
            for person in people:
                first = person.get('_firstName', '').strip()
                last = person.get('_lastName', '').strip()
                full_name = f'{first} {last}'.strip()
                pid = person.get('_pid', {})
                player_id = str(pid.get('Number', '')) if pid else ''
                roster.append({'name': full_name, 'player_id': player_id})
        else:
            # Pairs format: _person1, _person2
            for key in ('_person1', '_person2'):
                person = p.get(key)
                if person:
                    first = person.get('_firstName', '').strip()
                    last = person.get('_lastName', '').strip()
                    full_name = f'{first} {last}'.strip()
                    pid = person.get('_pid', {})
                    player_id = str(pid.get('Number', '')) if pid else ''
                    roster.append({'name': full_name, 'player_id': player_id})

        # Build display name
        name = p.get('_name', '').strip() or p.get('_shortName', '').strip()
        if not name and roster:
            name = ' & '.join(r['name'] for r in roster)
        if not name:
            name = f'#{number}'

        rows.append({
            'tournament_id': tournament_id,
            'number': number,
            'name': name,
            'roster': roster,
        })

    return rows


# ── Parse hands from hand record ─────────────────────────────────

def parse_hand_record(hand_record):
    """Parse the _handRecord from a board's distribution.

    Hand fields are JSON-encoded strings in Srini format.
    """
    hands = {}
    for direction in ['N', 'E', 'S', 'W']:
        raw = hand_record.get(f'Hand{direction}', '{}')
        if isinstance(raw, str):
            h = json.loads(raw)
        else:
            h = raw
        dl = direction.lower()
        hands[f'{dl}_spades'] = h.get('Spades', '')
        hands[f'{dl}_hearts'] = h.get('Hearts', '')
        hands[f'{dl}_diamonds'] = h.get('Diamonds', '')
        hands[f'{dl}_clubs'] = h.get('Clubs', '')

    return hands


def parse_dd_tricks(hand_record):
    """Parse double-dummy tricks from hand record."""
    dd = {}
    for direction in ['N', 'E', 'S', 'W']:
        raw = hand_record.get(f'TricksFrom{direction}', '{}')
        if isinstance(raw, str):
            tricks = json.loads(raw) if raw else {}
        else:
            tricks = raw or {}
        dl = direction.lower()
        dd[f'dd_{dl}_c'] = tricks.get('Clubs')
        dd[f'dd_{dl}_d'] = tricks.get('Diamonds')
        dd[f'dd_{dl}_h'] = tricks.get('Hearts')
        dd[f'dd_{dl}_s'] = tricks.get('Spades')
        dd[f'dd_{dl}_nt'] = tricks.get('Nt')

    return dd


# ── Parse boards ──────────────────────────────────────────────────

def parse_board(board_data, tournament_id, stage=None):
    """Parse a single board's data into a bg_boards row and bg_board_results rows."""
    sg = board_data['ScoringGroups'][0]
    dist = sg.get('Distribution') or {}
    hand_record = dist.get('_handRecord') or {}
    board_number = dist.get('_numberAsPlayed', 0)

    if not hand_record or not board_number:
        return None, [], 0, 'none', 'N', {}

    # Hands
    hands = parse_hand_record(hand_record)

    # HCP
    hcp = {}
    for d in ['n', 'e', 's', 'w']:
        hcp[f'hcp_{d}'] = hand_hcp(
            hands[f'{d}_spades'], hands[f'{d}_hearts'],
            hands[f'{d}_diamonds'], hands[f'{d}_clubs']
        )

    # DD tricks
    dd = parse_dd_tricks(hand_record)

    # Dealer and vulnerability
    dealer = SRINI_DEALER_MAP.get(hand_record.get('Dealer', 0), 'N')
    vul_code = hand_record.get('Vulnerability', 0)
    vulnerability = SRINI_VUL_MAP.get(vul_code, 'none')

    # Minimax
    minimax = hand_record.get('MiniMax')

    # Optimal score from minimax string (e.g., "2h S +140" → 140)
    optimal_score = _parse_minimax_score(minimax)

    board_row = {
        'tournament_id': tournament_id,
        'board_number': board_number,
        'stage': stage,
        'round': None,  # Srini boards are shared across rounds within a stage
        'dealer': dealer,
        'vulnerability': vulnerability,
        **hands,
        **hcp,
        **dd,
        'minimax': minimax,
        'optimal_score': optimal_score,
    }

    return board_row, sg['Scores'], board_number, vulnerability, dealer, hands


def _parse_minimax_score(minimax):
    if not minimax:
        return None
    m = re.search(r'[+-]?\d+$', minimax.strip())
    return int(m.group()) if m else None


# ── Parse score entries ───────────────────────────────────────────

def parse_score_entry(entry, board_id, tournament_id, participant_map,
                      vulnerability, dealer, hands, is_teams,
                      player_lineups=None):
    """Parse a single score entry into a bg_board_results row."""
    ns_score = entry.get('NsScore')

    # Not played or passed out
    if not ns_score or not isinstance(ns_score, dict):
        return None
    if not ns_score.get('WithContract', True):
        return None

    contract_info = ns_score.get('Contract', {})
    contract_contract = contract_info.get('Contract', {})

    # Contract details
    contract_level = contract_contract.get('Height', 0)
    if contract_level == 0:
        return None  # no result / not played at this table

    denom_idx = contract_contract.get('Denomination', 0)
    contract_denom = SRINI_DENOM_MAP.get(denom_idx, 'C')
    xx = contract_contract.get('Xx', 0)
    contract_x = 'XX' if xx == 2 else ('X' if xx == 1 else None)
    contract = contract_display(contract_level, contract_denom, contract_x)

    # Declarer
    decl_idx = contract_info.get('Declarer', 0)
    declarer = SRINI_DECL_MAP.get(decl_idx, 'N')

    # Lead
    lead_info = ns_score.get('Lead') or {}
    lead_suit = SRINI_SUIT_MAP.get(lead_info.get('CardColor'), None) if lead_info else None
    lead_rank = SRINI_CARD_MAP.get(lead_info.get('CardHeight'), None) if lead_info else None
    lead = f'{lead_suit}{lead_rank}' if lead_suit and lead_rank else None

    # Result
    overtricks = ns_score.get('Overtricks', 0)
    tricks = contract_level + 6 + overtricks
    score = ns_score.get('Score', 0)

    # Participants
    host_num = entry.get('Host', {}).get('Number')
    guest_num = entry.get('Guest', {}).get('Number')
    ns_parts = entry.get('ParticipantsNs', [])
    ew_parts = entry.get('ParticipantsWe', [])
    ns_num = ns_parts[0]['Number'] if ns_parts else host_num
    ew_num = ew_parts[0]['Number'] if ew_parts else guest_num

    ns_participant_id = participant_map.get(ns_num)
    ew_participant_id = participant_map.get(ew_num)

    # Room (teams only)
    room = None
    if is_teams:
        room = 'open' if entry.get('OpenRoom', False) else 'closed'

    # Match ID: for teams, link open+closed room by host+guest numbers
    match_id = None
    if is_teams and host_num is not None and guest_num is not None:
        match_id = f'r{entry.get("Round", 0)}_m{min(host_num, guest_num)}v{max(host_num, guest_num)}'

    round_num = entry.get('Round')
    table_number = entry.get('Table') or entry.get('TableToShow')

    # IMPs (teams) or matchpoints (pairs)
    imps_ns = None
    imps_ew = None
    mp_ns = None
    mp_ew = None
    datum_ns = None
    datum_ew = None

    if is_teams:
        imps_ns = entry.get('NsResult')
        imps_ew = entry.get('WeResult')
        datum_ns = entry.get('NsIndividualTeams')
        datum_ew = entry.get('WeIndividualTeams')
    else:
        mp_ns = entry.get('NsResult')
        mp_ew = entry.get('WeResult')

    # Player lineups from segment files
    player_n_name = None
    player_n_id = None
    player_s_name = None
    player_s_id = None
    player_e_name = None
    player_e_id = None
    player_w_name = None
    player_w_id = None

    if player_lineups and table_number and round_num and room:
        lineup = player_lineups.get((str(table_number), round_num, room))
        if lineup:
            player_n_name = lineup['n_name']
            player_n_id = lineup['n_id']
            player_s_name = lineup['s_name']
            player_s_id = lineup['s_id']
            player_e_name = lineup['e_name']
            player_e_id = lineup['e_id']
            player_w_name = lineup['w_name']
            player_w_id = lineup['w_id']

    # Generate LIN
    lin = generate_lin(
        dealer=dealer,
        vulnerability=vulnerability,
        hands=hands,
        contract_level=contract_level,
        contract_denom=contract_denom,
        contract_x=contract_x,
        declarer=declarer,
        lead_suit=lead_suit,
        lead_rank=lead_rank,
        tricks=tricks,
    )

    return {
        'board_id': board_id,
        'tournament_id': tournament_id,
        'ns_participant_id': ns_participant_id,
        'ew_participant_id': ew_participant_id,
        'match_id': match_id,
        'contract': contract,
        'contract_level': contract_level,
        'contract_denom': contract_denom,
        'contract_x': contract_x,
        'declarer': declarer,
        'passed_out': False,
        'lead': lead,
        'lead_suit': lead_suit,
        'lead_rank': lead_rank,
        'tricks': tricks,
        'overtricks': overtricks,
        'score': score,
        'mp_ns': mp_ns,
        'mp_ew': mp_ew,
        'imps_ns': imps_ns,
        'imps_ew': imps_ew,
        'datum_ns': datum_ns,
        'datum_ew': datum_ew,
        'room': room,
        'round': round_num,
        'stage': None,  # set by caller
        'table_number': str(table_number) if table_number else None,
        'player_n_name': player_n_name,
        'player_n_id': player_n_id,
        'player_s_name': player_s_name,
        'player_s_id': player_s_id,
        'player_e_name': player_e_name,
        'player_e_id': player_e_id,
        'player_w_name': player_w_name,
        'player_w_id': player_w_id,
        'lin': lin,
        'remarks': None,
    }


# ── Fetch per-table player lineups from segment files ─────────────

def _person_name(person):
    """Extract full name from a _person1/_person2 object."""
    if not person or not isinstance(person, dict):
        return None
    first = person.get('_firstName', '').strip()
    last = person.get('_lastName', '').strip()
    name = f'{first} {last}'.strip()
    return name if name else None


def _person_id(person):
    """Extract player ID from a _person1/_person2 object."""
    if not person or not isinstance(person, dict):
        return None
    pid = person.get('_pid', {})
    num = pid.get('Number') if pid else None
    return str(num) if num else None


def fetch_player_lineups(base_url, settings):
    """Fetch segment table files to get per-table player lineups.

    Returns a dict keyed by (table, round, room) → {
        'n_name', 'n_id', 's_name', 's_id',
        'e_name', 'e_id', 'w_name', 'w_id'
    }
    """
    seg_tables = settings.get('AvailableSegmentsTables', [])
    if not seg_tables:
        return {}

    rounds = settings.get('LastFinishedRound', 0)
    unique_tables = sorted(set(seg_tables))

    lineups = {}
    fetched = 0
    errors = 0

    for round_num in range(1, rounds + 1):
        for table in unique_tables:
            # URL: s{table}-{session}-{round}-{segment}.json
            # session=1, segment=0 for standard single-session events
            path = f's{table}-1-{round_num}-0.json'
            try:
                data = fetch_json(f'{base_url}/{path}')
            except Exception:
                errors += 1
                continue
            fetched += 1

            for room_key, room_label in [('Open', 'open'), ('Closed', 'closed')]:
                ns_data = data.get(f'{room_key}Ns', {})
                we_data = data.get(f'{room_key}We', {})

                p1_ns = ns_data.get('_person1')
                p2_ns = ns_data.get('_person2')
                p1_we = we_data.get('_person1')
                p2_we = we_data.get('_person2')

                key = (table, round_num, room_label)
                lineups[key] = {
                    'n_name': _person_name(p1_ns),
                    'n_id': _person_id(p1_ns),
                    's_name': _person_name(p2_ns),
                    's_id': _person_id(p2_ns),
                    'e_name': _person_name(p1_we),
                    'e_id': _person_id(p1_we),
                    'w_name': _person_name(p2_we),
                    'w_id': _person_id(p2_we),
                }

    print(f'  Fetched {fetched} segment files ({errors} errors), {len(lineups)} lineups')
    return lineups


# ── Determine stage for a board number ────────────────────────────

def build_stage_map(settings):
    """Build a mapping of board_number → stage name from AllStages."""
    stages = settings.get('AllStages', [])
    if not stages:
        return {}

    # Sort stages by _exampleBoardNumber to determine ranges
    valid = [s for s in stages if s.get('_exampleBoardNumber', 0) > 0]
    if not valid:
        return {}

    valid.sort(key=lambda s: s['_exampleBoardNumber'])
    all_boards = sorted(settings.get('BoardsNumbers', []))
    if not all_boards:
        return {}

    stage_map = {}
    for i, stage in enumerate(valid):
        start = stage['_exampleBoardNumber']
        end = valid[i + 1]['_exampleBoardNumber'] if i + 1 < len(valid) else max(all_boards) + 1
        name = stage.get('_name', '').strip().lower().replace(' ', '_')
        for b in all_boards:
            if start <= b < end:
                stage_map[b] = name

    # Boards before the first stage marker belong to the default stage
    first_marker = valid[0]['_exampleBoardNumber']
    default_stage = stages[0].get('_name', 'swiss').strip().lower().replace(' ', '_')
    for b in all_boards:
        if b < first_marker:
            stage_map[b] = default_stage

    return stage_map


# ── Main scrape logic ─────────────────────────────────────────────

def scrape(base_url, dry_run=False):
    """Scrape a Srini-format tournament and write to Supabase."""
    base_url = base_url.rstrip('/')

    # 1. Validate URL
    print(f'Validating {base_url}...')
    settings = validate_url(base_url)
    tournament_name = settings.get('FullName', '').strip()
    tt = settings.get('TournamentType', 0)
    is_teams = tt == 2
    event_type = 'teams' if is_teams else 'pairs'
    print(f'  Tournament: {tournament_name}')
    print(f'  Type: {event_type}')
    print(f'  Boards: {len(settings.get("BoardsNumbers", []))}')

    if not dry_run:
        if tournament_exists(base_url):
            print(f'  Tournament already exists. Skipping.')
            return

    # 2. Parse tournament metadata
    meta = parse_tournament_meta(settings, base_url)

    if dry_run:
        print(f'\n[DRY RUN] Would create tournament: {meta["name"]}')
    else:
        tournament_id = insert_tournament(meta)
        print(f'  Created tournament: {tournament_id}')

    # 3. Fetch and insert participants
    print('Fetching results (participants)...')
    results_data = fetch_json(f'{base_url}/results.json')

    if dry_run:
        participants = parse_participants(results_data, 'dry-run')
        print(f'  Found {len(participants)} participants')
        participant_map = {p['number']: f'id-{p["number"]}' for p in participants}
    else:
        participants = parse_participants(results_data, tournament_id)
        print(f'  Inserting {len(participants)} participants...')
        participant_map = insert_participants(participants)

    # 4. Build stage map
    stage_map = build_stage_map(settings)

    # 4b. Fetch player lineups (teams only)
    player_lineups = {}
    if is_teams and settings.get('AvailableSegmentsTables'):
        print('Fetching player lineups...')
        player_lineups = fetch_player_lineups(base_url, settings)

    # 5. Fetch and insert boards + results
    all_boards = settings.get('BoardsNumbers', [])
    print(f'Fetching {len(all_boards)} boards...')

    board_rows = []
    result_rows = []
    errors = []

    for board_num in all_boards:
        try:
            board_data = fetch_json(f'{base_url}/p{board_num}.json')
        except Exception as e:
            errors.append(f'Board {board_num}: {e}')
            continue

        stage = stage_map.get(board_num)

        board_row, scores, bn, vulnerability, dealer, hands = parse_board(
            board_data, tournament_id if not dry_run else 'dry-run', stage
        )
        if board_row is None:
            errors.append(f'Board {board_num}: no hand record')
            continue
        board_rows.append(board_row)

        # Parse each score entry
        for entry in scores:
            try:
                result = parse_score_entry(
                    entry,
                    board_id=None,  # filled in after board insert
                    tournament_id=tournament_id if not dry_run else 'dry-run',
                    participant_map=participant_map,
                    vulnerability=vulnerability,
                    dealer=dealer,
                    hands=hands,
                    is_teams=is_teams,
                    player_lineups=player_lineups,
                )
                if result is None:
                    continue
                result['_board_number'] = bn
                result['stage'] = stage
                result_rows.append(result)
            except Exception as e:
                errors.append(f'Board {bn}, entry: {e}')

        # Progress
        if board_num % 10 == 0 or board_num == all_boards[-1]:
            print(f'  Processed board {board_num}/{all_boards[-1]}')

    if dry_run:
        print(f'\n[DRY RUN] Summary:')
        print(f'  Boards: {len(board_rows)}')
        print(f'  Results: {len(result_rows)}')
        if errors:
            print(f'  Errors: {len(errors)}')
            for e in errors[:5]:
                print(f'    {e}')
        return

    # Insert boards
    print(f'Inserting {len(board_rows)} boards...')
    board_id_map = insert_boards(board_rows)

    # Map board_number → board_id for results
    board_num_to_id = {}
    for (stage, rnd, bnum), bid in board_id_map.items():
        board_num_to_id[bnum] = bid

    # Fill in board_id on results
    for result in result_rows:
        bn = result.pop('_board_number')
        result['board_id'] = board_num_to_id.get(bn)

    # Remove results with no board_id (shouldn't happen)
    result_rows = [r for r in result_rows if r.get('board_id')]

    print(f'Inserting {len(result_rows)} board results...')
    insert_board_results(result_rows)

    print(f'\nDone!')
    print(f'  Tournament: {tournament_name}')
    print(f'  Boards: {len(board_rows)}')
    print(f'  Results: {len(result_rows)}')
    if errors:
        print(f'  Errors ({len(errors)}):')
        for e in errors[:10]:
            print(f'    {e}')


# ── CLI ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Scrape a Tournament Calculator (Srini format) tournament into Supabase.'
    )
    parser.add_argument('url', help='Tournament root URL (must contain settings.json)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Validate and parse without writing to database')
    args = parser.parse_args()

    try:
        scrape(args.url, dry_run=args.dry_run)
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f'FATAL: {e}', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
