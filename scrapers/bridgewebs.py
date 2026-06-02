#!/usr/bin/env python3
"""
Scraper for BridgeWebs format (bridgewebs.com).

Scrapes pairs tournament data from BridgeWebs clubs and writes to Supabase bg_ tables.
Uses the XML/AJAX API — a single call to xml_results_travs gets all data.

Usage:
    python3 scrapers/bridgewebs.py <url> [--dry-run]

Examples:
    python3 scrapers/bridgewebs.py "https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?pid=display_rank&event=20260429_1&club=tnba"
"""

import argparse
import re
import ssl
import sys
import urllib.request
import urllib.parse
from xml.etree import ElementTree

from utils import hand_hcp, contract_display, compute_dd
from lin import generate_lin
from db import (
    upsert_tournament, upsert_event, upsert_stage,
    insert_participants, find_participants, insert_boards,
    insert_board_results, stage_exists, update_board_dd,
)

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


# ── URL parsing ───────────────────────────────────────────────────

def parse_bridgewebs_url(url):
    """Extract club and event from a BridgeWebs URL.
    Returns (club, event_key).
    """
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(parsed.query)

    club = params.get('club', [None])[0]
    event = params.get('event', params.get('ekey', [None]))[0]

    if not club:
        m = re.search(r'club=([^&]+)', url)
        club = m.group(1) if m else None
    if not event:
        m = re.search(r'event=([^&]+)', url)
        event = m.group(1) if m else None

    if not club or not event:
        raise ValueError(
            f'Cannot extract club and event from URL.\n'
            f'Expected: https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?pid=display_rank&event=YYYYMMDD_N&club=CLUBID'
        )

    return club, event


# ── HTTP fetching ─────────────────────────────────────────────────

def fetch_xml(club, event, pid):
    """Fetch XML data from BridgeWebs API."""
    url = (f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?xml=1'
           f'&club={club}&pid={pid}&ekey={event}&msec=1&mod=Results')
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': '*/*',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        return resp.read().decode('utf-8')


def fetch_rank_xml(club, event):
    """Fetch ranking/results XML."""
    return fetch_xml(club, event, 'xml_results_rank')


def fetch_travs_xml(club, event):
    """Fetch all travellers XML — the main data source."""
    return fetch_xml(club, event, 'xml_results_travs')


# ── Parse XML helpers ─────────────────────────────────────────────

def parse_pages(xml_text):
    """Parse BridgeWebs XML into page dicts.
    Data is in <alltravs><page>...</page>...</alltravs> or <results> wrapper.
    """
    content = xml_text
    # Try <results> wrapper (some responses wrap page data in escaped HTML)
    results_match = re.search(r'<results>(.*?)</results>', content, re.DOTALL)
    if results_match and len(results_match.group(1).strip()) > 0:
        content = results_match.group(1)
        content = content.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')

    pages = []
    for page_match in re.finditer(r'<page>(.*?)</page>', content, re.DOTALL):
        page_xml = page_match.group(1)
        page = {}
        for tag in ['view', 'bd', 'sess', 'title', 'subtitle', 'dlr', 'vul',
                     'hand', 'commentary', 'cols', 'format', 'type']:
            m = re.search(f'<{tag}>(.*?)</{tag}>', page_xml, re.DOTALL)
            if m:
                page[tag] = m.group(1).strip()

        rows = []
        for rw_match in re.finditer(r'<rw>(.*?)</rw>', page_xml):
            rows.append(rw_match.group(1).strip())
        page['rows'] = rows
        pages.append(page)

    return pages


# ── Parse players (view=6) ────────────────────────────────────────

def _parse_pair_key(s):
    """Parse a pair identifier that may have a section prefix (e.g. 'A1' → ('A1', 1)).
    Section letters offset the number: A=0, B=100, C=200, etc. to avoid collisions.
    """
    s = s.strip()
    if not s:
        return None, None
    m = re.match(r'^([A-Za-z]?)(\d+)$', s)
    if m:
        prefix = m.group(1).upper()
        num = int(m.group(2))
        offset = (ord(prefix) - ord('A')) * 100 if prefix else 0
        return s, offset + num
    return s, None


def parse_players(pages):
    """Extract player list from view=6 pages."""
    players = {}
    for page in pages:
        if page.get('view') != '6':
            continue
        for row in page.get('rows', []):
            parts = row.split(';')
            if len(parts) < 6:
                continue
            # item;way;internal_pair;display_pair;name1;name2;...
            display_pair = parts[3].strip()
            name1 = parts[4].strip().lstrip('.,')
            name2 = parts[5].strip().lstrip('.,')
            pair_key, pair_num = _parse_pair_key(display_pair)
            if pair_key is None:
                continue
            players[pair_key] = {
                'number': pair_num or 0,
                'name1': name1,
                'name2': name2,
                'name': f'{name1} & {name2}',
            }
    return players


# ── Parse hand record ─────────────────────────────────────────────

DEALER_MAP_BW = {'1': 'N', '2': 'E', '3': 'S', '4': 'W'}
VUL_MAP_BW = {'1': 'none', '2': 'ns', '3': 'ew', '4': 'both'}

def parse_hand_from_field(hand_str):
    """Parse the hand field (semicolon-separated) into structured data.
    Positions 0-15: suits (N-S-H-D-C, E-S-H-D-C, S-S-H-D-C, W-S-H-D-C)
    Positions 16-19: HCP
    Positions 20-39: DD tricks (when available)
    Position 40+: optimum contract
    """
    parts = hand_str.split(';')
    if len(parts) < 16:
        return None

    # Cards use T for 10
    hands = {}
    dirs = ['n', 'e', 's', 'w']
    suits = ['spades', 'hearts', 'diamonds', 'clubs']
    for i, d in enumerate(dirs):
        for j, s in enumerate(suits):
            idx = i * 4 + j
            holding = parts[idx].strip() if idx < len(parts) else ''
            if holding == '--':
                holding = ''
            hands[f'{d}_{s}'] = holding

    # HCP
    hcp = {}
    for i, d in enumerate(dirs):
        idx = 16 + i
        try:
            hcp[f'hcp_{d}'] = int(parts[idx]) if idx < len(parts) and parts[idx].strip() else None
        except ValueError:
            hcp[f'hcp_{d}'] = None

    # DD tricks (positions 20-39)
    dd = {}
    dd_denoms = ['c', 'd', 'h', 's', 'nt']
    dd_dirs = ['n', 's', 'e', 'w']
    has_dd = False
    for i, d in enumerate(dd_dirs):
        for j, denom in enumerate(dd_denoms):
            idx = 20 + i * 5 + j
            try:
                val = int(parts[idx]) if idx < len(parts) and parts[idx].strip() else None
                dd[f'dd_{d}_{denom}'] = val
                if val is not None and val > 0:
                    has_dd = True
            except ValueError:
                dd[f'dd_{d}_{denom}'] = None

    if not has_dd:
        dd = {k: None for k in dd}

    # Optimum
    minimax = parts[40].strip() if len(parts) > 40 and parts[40].strip() else None

    return hands, hcp, dd, minimax


# ── Parse traveller rows (view=3) ─────────────────────────────────

LEAD_SUIT_MAP = {'D': 'D', 'H': 'H', 'S': 'S', 'C': 'C'}

def parse_contract_bw(contract_str):
    """Parse BridgeWebs contract string like '3NT', '4S', '4H*', '3CXX'."""
    s = contract_str.strip()
    if not s:
        return None

    # Handle doubled/redoubled
    x = None
    if s.endswith('**') or s.endswith('XX') or s.endswith('xx'):
        x = 'XX'
        s = s[:-2]
    elif s.endswith('*') or s.endswith('X') or s.endswith('x'):
        x = 'X'
        s = s[:-1]

    m = re.match(r'^(\d)([CDHSN]T?)', s, re.IGNORECASE)
    if not m:
        return None

    level = int(m.group(1))
    denom_raw = m.group(2).upper()
    denom = 'NT' if denom_raw in ('NT', 'N') else denom_raw

    return {'level': level, 'denom': denom, 'x': x}


def parse_lead_bw(lead_str):
    """Parse lead like 'DK', 'HA', 'S10', 'CT'."""
    s = lead_str.strip()
    if not s or len(s) < 2:
        return None, None, None

    suit = s[0].upper()
    if suit not in 'SHDC':
        return None, None, None

    rank = s[1:].upper()
    if rank == '10':
        rank = 'T'

    return suit, rank, s


def parse_tricks_bw(tricks_str, contract_level):
    """Parse tricks field. Can be absolute (like '9') or relative ('+1', '-2', '=')."""
    s = tricks_str.strip()
    if not s:
        return None, None

    if s == '=':
        return contract_level + 6, 0
    elif s.startswith('+'):
        ot = int(s[1:])
        return contract_level + 6 + ot, ot
    elif s.startswith('-'):
        ot = int(s)
        return contract_level + 6 + ot, ot
    else:
        try:
            total = int(s)
            return total, total - (contract_level + 6)
        except ValueError:
            return None, None


# ── Main scrape logic ─────────────────────────────────────────────

def scrape(url, dry_run=False):
    """Scrape a BridgeWebs event and write to Supabase.

    Hierarchy: bg_tournaments → bg_events → bg_stages → bg_boards → bg_board_results
    """
    club, event = parse_bridgewebs_url(url)
    print(f'Club: {club}, Event: {event}')

    source_url = f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?pid=display_rank&event={event}&club={club}'

    if not dry_run and stage_exists(source_url):
        print('  Event already scraped. Skipping.')
        return

    # Fetch all traveller data (single call gets everything)
    print('Fetching traveller data...')
    xml_text = fetch_travs_xml(club, event)
    pages = parse_pages(xml_text)
    print(f'  Parsed {len(pages)} pages')

    # Parse players
    player_data = parse_players(pages)
    print(f'  Found {len(player_data)} pairs')

    # Parse boards (view=3 pages)
    board_pages = [p for p in pages if p.get('view') == '3']
    print(f'  Found {len(board_pages)} boards')

    if not board_pages:
        print('  No board data found.')
        return

    event_date = _event_date(event)
    tournament_name = f'{club.upper()} {event_date or event}'

    # ── Create hierarchy: tournament → event → stage ──

    tournament_data = {
        'name': tournament_name,
        'location': None,
        'date_start': event_date,
        'source_format': 'bridgewebs',
        'source_meta': {'club': club},
    }

    event_data_template = {
        'name': 'Pairs',
        'type': 'pairs',
        'scoring': 'mp',
        'event_order': 1,
        'source_url': source_url,
        'source_meta': {'club': club, 'event': event},
    }

    stage_data_template = {
        'name': 'Session',
        'stage_order': 1,
        'source_url': source_url,
        'source_meta': {'club': club, 'event': event},
    }

    if dry_run:
        print(f'\n[DRY RUN] Tournament: {tournament_name}')
        tournament_id = 'dry-run-t'
        event_id = 'dry-run-e'
        stage_id = 'dry-run-s'
    else:
        tournament_id = upsert_tournament(tournament_data)
        print(f'  Tournament: {tournament_id}')

        event_data_template['tournament_id'] = tournament_id
        event_id = upsert_event(event_data_template)
        print(f'  Event: {event_id}')

        stage_data_template['event_id'] = event_id
        stage_id = upsert_stage(stage_data_template)
        print(f'  Stage: {stage_id}')

    # Insert participants (linked to event)
    # player_data is keyed by display string (e.g. "A1"), number is the int part
    participant_rows = []
    key_to_number = {}
    for pkey, pdata in sorted(player_data.items()):
        participant_rows.append({
            'event_id': event_id,
            'number': pdata['number'],
            'name': pdata['name'],
            'roster': [
                {'name': pdata['name1'], 'player_id': ''},
                {'name': pdata['name2'], 'player_id': ''},
            ],
        })
        key_to_number[pkey] = pdata['number']

    if dry_run:
        participant_map = {pkey: f'id-{pkey}' for pkey in player_data}
    else:
        existing = find_participants(event_id)
        new_rows = [r for r in participant_rows if r['number'] not in existing]
        if new_rows:
            print(f'  Inserting {len(new_rows)} participants ({len(existing)} existing)...')
            num_to_id = {**existing, **insert_participants(new_rows)}
        else:
            print(f'  {len(existing)} participants already exist, skipping insert.')
            num_to_id = existing
        participant_map = {pkey: num_to_id.get(num) for pkey, num in key_to_number.items()}

    # Parse boards and results
    board_rows = []
    result_rows = []
    errors = []

    for page in board_pages:
        try:
            bn = int(page.get('bd', '0'))
            if bn == 0:
                continue

            dealer = DEALER_MAP_BW.get(page.get('dlr', '1'), 'N')
            vul = VUL_MAP_BW.get(page.get('vul', '1'), 'none')

            # Parse hand
            hand_field = page.get('hand', '')
            hands = {}
            hcp = {}
            dd = {}
            minimax = None
            optimal_score = None

            if hand_field:
                parsed_hand = parse_hand_from_field(hand_field)
                if parsed_hand:
                    hands, hcp, dd, minimax = parsed_hand
                    for d in ['n', 'e', 's', 'w']:
                        if hcp.get(f'hcp_{d}') is None:
                            hcp[f'hcp_{d}'] = hand_hcp(
                                hands.get(f'{d}_spades', ''),
                                hands.get(f'{d}_hearts', ''),
                                hands.get(f'{d}_diamonds', ''),
                                hands.get(f'{d}_clubs', ''),
                            )

            if not hands:
                for d in ['n', 'e', 's', 'w']:
                    for s in ['spades', 'hearts', 'diamonds', 'clubs']:
                        hands[f'{d}_{s}'] = ''
                    hcp[f'hcp_{d}'] = None
                dd = {f'dd_{d}_{denom}': None for d in ['n', 'e', 's', 'w']
                      for denom in ['c', 'd', 'h', 's', 'nt']}

            board_rows.append({
                'stage_id': stage_id,
                'board_number': bn,
                'round': None,
                'dealer': dealer,
                'vulnerability': vul,
                **hands,
                **hcp,
                **dd,
                'minimax': minimax,
                'optimal_score': optimal_score,
            })

            # Parse traveller rows
            for row in page.get('rows', []):
                try:
                    parts = row.split(';')
                    if len(parts) < 8:
                        continue

                    ns_key, _ = _parse_pair_key(parts[0])
                    ew_key, _ = _parse_pair_key(parts[1])
                    if not ns_key or not ew_key:
                        continue
                    contract_str = parts[2].strip()
                    declarer = parts[3].strip().upper()
                    lead_str = parts[4].strip()
                    tricks_str = parts[5].strip()
                    ns_score_str = parts[6].strip()
                    ew_score_str = parts[7].strip()
                    mp_ns_str = parts[8].strip() if len(parts) > 8 else ''
                    mp_ew_str = parts[9].strip() if len(parts) > 9 else ''

                    if not contract_str:
                        continue

                    passed_out = contract_str.upper() in ('PASS', 'P', 'NP', 'A-')
                    if passed_out:
                        result_rows.append({
                            'board_id': None, 'stage_id': stage_id,
                            '_board_number': bn,
                            'ns_participant_id': participant_map.get(ns_key),
                            'ew_participant_id': participant_map.get(ew_key),
                            'match_id': None, 'contract': None,
                            'contract_level': None, 'contract_denom': None,
                            'contract_x': None, 'declarer': None,
                            'passed_out': True,
                            'lead': None, 'lead_suit': None, 'lead_rank': None,
                            'tricks': 0, 'overtricks': None, 'score': 0,
                            'mp_ns': _parse_float(mp_ns_str),
                            'mp_ew': _parse_float(mp_ew_str),
                            'imps_ns': None, 'imps_ew': None,
                            'datum_ns': None, 'datum_ew': None,
                            'room': None, 'round': None,
                            'table_number': None,
                            'player_n_name': player_data.get(ns_key, {}).get('name1'),
                            'player_n_id': None,
                            'player_s_name': player_data.get(ns_key, {}).get('name2'),
                            'player_s_id': None,
                            'player_e_name': player_data.get(ew_key, {}).get('name1'),
                            'player_e_id': None,
                            'player_w_name': player_data.get(ew_key, {}).get('name2'),
                            'player_w_id': None,
                            'lin': None, 'remarks': None,
                        })
                        continue

                    parsed = parse_contract_bw(contract_str)
                    if not parsed:
                        continue

                    contract_level = parsed['level']
                    contract_denom = parsed['denom']
                    contract_x = parsed['x']
                    contract = contract_display(contract_level, contract_denom, contract_x)

                    lead_suit, lead_rank, lead = parse_lead_bw(lead_str)
                    tricks, overtricks = parse_tricks_bw(tricks_str, contract_level)

                    score = 0
                    if ns_score_str:
                        try:
                            score = int(ns_score_str)
                        except ValueError:
                            pass
                    elif ew_score_str:
                        try:
                            score = -int(ew_score_str)
                        except ValueError:
                            pass

                    mp_ns = _parse_float(mp_ns_str)
                    mp_ew = _parse_float(mp_ew_str)

                    ns_p = player_data.get(ns_key, {})
                    ew_p = player_data.get(ew_key, {})

                    lin = generate_lin(
                        dealer=dealer, vulnerability=vul, hands=hands,
                        contract_level=contract_level, contract_denom=contract_denom,
                        contract_x=contract_x, declarer=declarer,
                        lead_suit=lead_suit, lead_rank=lead_rank, tricks=tricks,
                        player_n=ns_p.get('name1'), player_s=ns_p.get('name2'),
                        player_e=ew_p.get('name1'), player_w=ew_p.get('name2'),
                    )

                    result_rows.append({
                        'board_id': None, 'stage_id': stage_id,
                        '_board_number': bn,
                        'ns_participant_id': participant_map.get(ns_key),
                        'ew_participant_id': participant_map.get(ew_key),
                        'match_id': None,
                        'contract': contract, 'contract_level': contract_level,
                        'contract_denom': contract_denom, 'contract_x': contract_x,
                        'declarer': declarer, 'passed_out': False,
                        'lead': lead, 'lead_suit': lead_suit, 'lead_rank': lead_rank,
                        'tricks': tricks, 'overtricks': overtricks,
                        'score': score,
                        'mp_ns': mp_ns, 'mp_ew': mp_ew,
                        'imps_ns': None, 'imps_ew': None,
                        'datum_ns': None, 'datum_ew': None,
                        'room': None, 'round': None,
                        'table_number': None,
                        'player_n_name': ns_p.get('name1'),
                        'player_n_id': None,
                        'player_s_name': ns_p.get('name2'),
                        'player_s_id': None,
                        'player_e_name': ew_p.get('name1'),
                        'player_e_id': None,
                        'player_w_name': ew_p.get('name2'),
                        'player_w_id': None,
                        'lin': lin, 'remarks': None,
                    })

                except Exception as e:
                    errors.append(f'Board {bn}, row: {e}')

        except Exception as e:
            errors.append(f'Page: {e}')

    if dry_run:
        print(f'\n[DRY RUN] Summary:')
        print(f'  Boards: {len(board_rows)}')
        print(f'  Results: {len(result_rows)}')
        if errors:
            print(f'  Errors: {len(errors)}')
            for e in errors[:5]:
                print(f'    {e}')
        return

    print(f'Inserting {len(board_rows)} boards...')
    board_id_map = insert_boards(board_rows)

    # Compute DD data for boards missing it
    needs_dd = [b for b in board_rows if b.get('dd_n_nt') is None]
    if needs_dd:
        print(f'Computing DD for {len(needs_dd)} boards...')
        dd_count = 0
        for b in needs_dd:
            dd = compute_dd(b)
            if dd:
                board_id = board_id_map.get((b.get('round'), b['board_number']))
                if board_id:
                    update_board_dd(board_id, dd)
                    dd_count += 1
        print(f'  Updated {dd_count} boards with DD data')

    for result in result_rows:
        bn = result.pop('_board_number')
        result['board_id'] = board_id_map.get((None, bn))

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


def _event_date(event_key):
    """Extract date from event key like '20260429_1'."""
    m = re.match(r'(\d{4})(\d{2})(\d{2})', event_key)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    return None


def _parse_float(s):
    try:
        return float(s) if s.strip() else None
    except ValueError:
        return None


# ── CLI ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Scrape a BridgeWebs event into Supabase.'
    )
    parser.add_argument('url', help='BridgeWebs results URL')
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
