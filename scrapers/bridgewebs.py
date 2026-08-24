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

from utils import hand_hcp, contract_display, fill_dd
from lin import generate_lin
from db import (
    upsert_tournament, upsert_event, upsert_stage,
    insert_participants, find_participants, insert_boards,
    insert_board_results, stage_exists, update_board_dd,
    find_tournament_by_stage_url,
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

def _decode(raw):
    """BridgeWebs serves pages as Windows-1252, not UTF-8 (e.g. curly quotes
    show up as byte 0x93). Try UTF-8 first, fall back to cp1252."""
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('cp1252', errors='replace')


def fetch_xml(club, event, pid):
    """Fetch XML data from BridgeWebs API."""
    url = (f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?xml=1'
           f'&club={club}&pid={pid}&ekey={event}&msec=1&mod=Results')
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': '*/*',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        return _decode(resp.read())


def fetch_rank_xml(club, event):
    """Fetch ranking/results XML."""
    return fetch_xml(club, event, 'xml_results_rank')


def fetch_travs_xml(club, event):
    """Fetch all travellers XML — the main data source."""
    return fetch_xml(club, event, 'xml_results_travs')


def detect_scoring(club, event):
    """Detect if an event uses IMP or MP scoring from the rank XML.
    MP events have non-zero Score % values; IMP events show 0.
    """
    try:
        xml_text = fetch_rank_xml(club, event)
        decoded = xml_text.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', decoded, re.DOTALL)
        for row in rows[1:4]:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) >= 5:
                score_pct = cells[4].strip().replace('&nbsp;', '').replace('\xa0', '')
                try:
                    if float(score_pct) > 0:
                        return 'mp'
                except ValueError:
                    continue
        return 'imp'
    except Exception:
        return 'mp'


def fetch_event_title(club, event):
    """Fetch result_title and club_name from the display_rank page.
    Returns (result_title, club_name) — e.g.
      ('1st June 2026 - EA TNBA - Morning', 'EXPRESS AVENUE BRIDGE TOURNAMENT RESULT')
    """
    url = (f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi'
           f'?pid=display_rank&event={event}&club={club}')
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': '*/*',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        html = _decode(resp.read())

    result_title = None
    club_name = None
    m = re.search(r"var result_title = '([^']*)'", html)
    if m:
        result_title = m.group(1).strip()
    m = re.search(r"var club_name = '([^']*)'", html)
    if m:
        club_name = m.group(1).strip()
    return result_title, club_name


def _strip_date_prefix(title):
    """Strip the leading date and HTML tags from a result_title.
    '11th June 2026<br>MP Pairs - Session 1' → 'MP Pairs - Session 1'
    '1st June 2026 - EA TNBA - Morning' → 'EA TNBA - Morning'
    """
    if not title:
        return title
    t = re.sub(r'<br\s*/?>', ' - ', title)
    m = re.match(r'^\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\s*-\s*', t)
    if m:
        return t[m.end():].strip()
    return t


def discover_sessions(club, date_str):
    """Discover all sessions for a club on a given date.
    Probes event keys date_1, date_2, ... until no board data is returned.
    Returns list of dicts: {event_key, title, pages, board_pages}.
    """
    sessions = []
    for n in range(1, 20):
        event_key = f'{date_str}_{n}'
        xml_text = fetch_travs_xml(club, event_key)
        pages = parse_pages(xml_text)
        board_pages = [p for p in pages if p.get('view') == '3']
        if not board_pages:
            break

        result_title, club_name = fetch_event_title(club, event_key)
        session_name = _strip_date_prefix(result_title) or f'Session {n}'
        scoring = detect_scoring(club, event_key) if n == 1 else sessions[0].get('scoring', 'mp')

        sessions.append({
            'event_key': event_key,
            'session_num': n,
            'title': session_name,
            'scoring': scoring,
            'club_name': club_name,
            'pages': pages,
            'board_pages': board_pages,
        })
        print(f'  Found session {n}: {session_name} ({len(board_pages)} boards)')

    return sessions


def _derive_names(sessions):
    """Derive event name and stage names from session titles.
    Returns (event_name, stage_names).

    ['...Matchpoint Pairs - Session 1', '...Matchpoint Pairs - Session 2']
      → ('Matchpoint Pairs', ['Session 1', 'Session 2'])
    ['EA TNBA - Morning', 'EA TNBA - Afternoon']
      → ('EA TNBA', ['Morning', 'Afternoon'])
    """
    titles = [s['title'] for s in sessions]

    if len(sessions) <= 1:
        return titles[0], titles

    prefix = titles[0]
    for t in titles[1:]:
        while prefix and not t.startswith(prefix):
            prefix = prefix[:-1]

    prefix = prefix.rstrip(' -–—')
    if len(prefix) < 3:
        return titles[0], titles

    event_name = prefix.strip()
    stripped = [t[len(prefix):].lstrip(' -–—').strip() or t for t in titles]
    if any(not s for s in stripped):
        return event_name, titles
    # If all stripped names are just numbers, keep more context
    if all(s.isdigit() for s in stripped):
        m = re.search(r'(\S+)\s*[-–—]?\s*$', prefix)
        if m:
            stripped = [f'{m.group(1)} {s}' for s in stripped]
            event_name = prefix[:m.start()].rstrip(' -–—').strip() or event_name
    return event_name, stripped


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

    # Positions 20-39 hold BridgeWebs' partial DD (makeable contracts
    # only, with 1 as a "nothing makeable" sentinel). We ignore it —
    # DD is always computed with endplay from the hands (see fill_dd).
    dd = {f'dd_{d}_{denom}': None
          for d in ['n', 's', 'e', 'w']
          for denom in ['c', 'd', 'h', 's', 'nt']}

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


# ── Parse a single session's boards and results ─────────────────

def _parse_session_data(board_pages, stage_id, player_data, participant_map, scoring='mp'):
    """Parse board and result rows from a session's board pages.
    Returns (board_rows, result_rows, errors).
    """
    board_rows = []
    result_rows = []
    errors = []
    seq_num = 0  # sequential 1-based board number; avoids BridgeWebs multi-session collisions

    for page in board_pages:
        try:
            orig_bn = int(page.get('bd', '0'))
            if orig_bn == 0:
                continue
            seq_num += 1
            bn = seq_num

            dealer = DEALER_MAP_BW.get(page.get('dlr', '1'), 'N')
            vul = VUL_MAP_BW.get(page.get('vul', '1'), 'none')

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
                            'mp_ns': _parse_float(mp_ns_str) if scoring != 'imp' else None,
                            'mp_ew': _parse_float(mp_ew_str) if scoring != 'imp' else None,
                            'imps_ns': _parse_float(mp_ns_str) if scoring == 'imp' else None,
                            'imps_ew': _parse_float(mp_ew_str) if scoring == 'imp' else None,
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
                    try:
                        score = int(ns_score_str)
                    except (ValueError, TypeError):
                        try:
                            score = -int(ew_score_str)
                        except (ValueError, TypeError):
                            pass

                    pts_ns = _parse_float(mp_ns_str)
                    pts_ew = _parse_float(mp_ew_str)

                    if scoring == 'imp':
                        mp_ns, mp_ew = None, None
                        imps_ns, imps_ew = pts_ns, pts_ew
                    else:
                        mp_ns, mp_ew = pts_ns, pts_ew
                        imps_ns, imps_ew = None, None

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
                        'imps_ns': imps_ns, 'imps_ew': imps_ew,
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

    return board_rows, result_rows, errors


# ── Main scrape logic ─────────────────────────────────────────────

def scrape(url, dry_run=False, name=None):
    """Scrape a single BridgeWebs session and write to Supabase.

    Scrapes only the session pointed to by the URL. Multiple sessions
    should be retrieved separately, each with their own URL.

    Hierarchy: bg_tournaments → bg_events → bg_stages → bg_boards → bg_board_results
    """
    club, event = parse_bridgewebs_url(url)
    event_date = _event_date(event)
    print(f'Club: {club}, Event: {event}, Date: {event_date}')

    source_url = f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?pid=display_rank&event={event}&club={club}'

    if not dry_run and stage_exists(source_url):
        print('  Already scraped. Skipping.')
        return find_tournament_by_stage_url(source_url)

    # ── Fetch data for this single session ──
    xml_text = fetch_travs_xml(club, event)
    pages = parse_pages(xml_text)
    board_pages = [p for p in pages if p.get('view') == '3']

    if not board_pages:
        print('  No board data found.')
        return

    result_title, club_name = fetch_event_title(club, event)
    scoring = detect_scoring(club, event)
    club_display = club_name or club.upper()
    tournament_name = name or (f'{club_display} - {event_date}' if event_date else club_display)
    stage_name = _strip_date_prefix(result_title) or 'main'

    print(f'Tournament: {tournament_name}')
    print(f'Stage: {stage_name} ({len(board_pages)} boards, {scoring})')

    # ── Create tournament, event, stage ──
    tournament_data = {
        'name': tournament_name,
        'location': None,
        'date_start': event_date,
        'source_format': 'bridgewebs',
        'source_meta': {'club': club},
    }

    event_data = {
        'name': tournament_name,
        'type': 'pairs',
        'scoring': scoring,
        'event_order': 1,
        'source_url': source_url,
        'source_meta': {'club': club, 'event_key': event},
    }

    if dry_run:
        print(f'\n[DRY RUN] Tournament: {tournament_name}')
        tournament_id = 'dry-run-t'
        event_id = 'dry-run-e'
        stage_id = 'dry-run-s'
    else:
        tournament_id = upsert_tournament(tournament_data)
        print(f'  Tournament ID: {tournament_id}')

        event_data['tournament_id'] = tournament_id
        event_id = upsert_event(event_data)
        print(f'  Event ID: {event_id}')

        stage_data = {
            'name': stage_name,
            'event_id': event_id,
            'stage_order': 1,
            'source_url': source_url,
            'source_meta': {'club': club, 'event': event},
        }
        stage_id = upsert_stage(stage_data)
        print(f'  Stage ID: {stage_id}')

    # ── Parse players, boards, results ──
    player_data = parse_players(pages)
    print(f'  {len(player_data)} pairs')

    if dry_run:
        participant_map = {pkey: f'id-{pkey}' for pkey in player_data}
    else:
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

        existing = find_participants(event_id)
        new_rows = [r for r in participant_rows if r['number'] not in existing]
        if new_rows:
            print(f'  Inserting {len(new_rows)} participants ({len(existing)} existing)...')
            num_to_id = {**existing, **insert_participants(new_rows)}
        else:
            print(f'  {len(existing)} participants already exist.')
            num_to_id = existing
        participant_map = {pkey: num_to_id.get(num) for pkey, num in key_to_number.items()}

    board_rows, result_rows, errors = _parse_session_data(
        board_pages, stage_id, player_data, participant_map, scoring=scoring)

    if dry_run:
        print(f'  [DRY RUN] {len(board_rows)} boards, {len(result_rows)} results')
        if errors:
            print(f'  Errors ({len(errors)}):')
            for e in errors[:10]:
                print(f'    {e}')
        return

    print(f'  Computing DD for {len(board_rows)} boards...')
    dd_count = fill_dd(board_rows)
    print(f'  DD solved for {dd_count}/{len(board_rows)} boards')

    print(f'  Inserting {len(board_rows)} boards...')
    board_id_map = insert_boards(board_rows)

    for result in result_rows:
        bn = result.pop('_board_number')
        result['board_id'] = board_id_map.get((None, bn))

    result_rows = [r for r in result_rows if r.get('board_id')]

    print(f'  Inserting {len(result_rows)} board results...')
    insert_board_results(result_rows)

    print(f'\nDone! {tournament_name}')
    print(f'  Boards: {len(board_rows)}')
    print(f'  Results: {len(result_rows)}')
    if errors:
        print(f'  Errors ({len(errors)}):')
        for e in errors[:10]:
            print(f'    {e}')
    return tournament_id


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


# ── Discovery ────────────────────────────────────────────────────

def _fetch_results_list_dates(club):
    """Fetch the results list page and extract unique dates (YYYYMMDD)."""
    url = f'https://www.bridgewebs.com/cgi-bin/bwor/bw.cgi?pid=results_list&club={club}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': '*/*',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        html = resp.read().decode('utf-8', errors='replace')

    MONTHS = {'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'may': '05', 'jun': '06',
              'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'}
    dates = set()
    for m in re.finditer(r'(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})', html):
        day, month_str, year = m.group(1), m.group(2).lower()[:3], m.group(3)
        month = MONTHS.get(month_str)
        if month:
            dates.add(f'{year}{month}{day.zfill(2)}')
    return sorted(dates)


def discover_club(url):
    """Discover all events and sessions for a BridgeWebs club.

    Returns {club, club_name, events: [{name, scoring, dates, sessions: [{event_key, date, title, session_name, boards}]}]}
    """
    import json

    club, event = parse_bridgewebs_url(url)
    print(f'Club: {club}')

    # Get the club display name
    _, club_name = fetch_event_title(club, event)
    print(f'Club name: {club_name}')

    # Find dates: start from the URL's date and probe ±30 days
    from datetime import datetime, timedelta
    base_date_str = re.match(r'(\d{8})', event).group(1)
    base_date = datetime.strptime(base_date_str, '%Y%m%d')
    # Also try dates from the results list page
    list_dates = set(_fetch_results_list_dates(club))
    probe_dates = set()
    for d in range(-30, 31):
        probe_dates.add((base_date + timedelta(days=d)).strftime('%Y%m%d'))
    probe_dates.update(list_dates)
    dates = sorted(probe_dates)
    print(f'  Probing {len(dates)} dates around {base_date_str}...')

    # Probe each date for sessions (title-only first pass for speed)
    all_sessions = []
    for date_str in dates:
        for n in range(1, 20):
            event_key = f'{date_str}_{n}'
            try:
                result_title, _ = fetch_event_title(club, event_key)
            except Exception:
                break
            if not result_title:
                break

            session_name = _strip_date_prefix(result_title)
            if not session_name:
                break

            # Quick check: fetch travs XML to count boards
            try:
                xml_text = fetch_travs_xml(club, event_key)
                pages = parse_pages(xml_text)
                board_pages = [p for p in pages if p.get('view') == '3']
            except Exception:
                break
            if not board_pages:
                break

            event_date = _event_date(event_key)
            all_sessions.append({
                'event_key': event_key,
                'date': event_date,
                'title': session_name,
                'boards': len(board_pages),
            })
            print(f'  {event_key}: {session_name} ({len(board_pages)} boards)')

    # Group sessions by event name (strip session number suffix)
    events = {}
    for sess in all_sessions:
        # Strip "Session N", "S-N", "S1", or trailing "N" after dash
        event_name = re.sub(r'\s*[-–]\s*(?:Session|S)?\s*\d+\s*$', '', sess['title'], flags=re.IGNORECASE).strip()
        if not event_name:
            event_name = sess['title']
        if event_name not in events:
            events[event_name] = {
                'name': event_name,
                'sessions': [],
                'dates': set(),
            }
        events[event_name]['sessions'].append(sess)
        events[event_name]['dates'].add(sess['date'])

    # Detect scoring for each event (check first session)
    for ev in events.values():
        first_key = ev['sessions'][0]['event_key']
        ev['scoring'] = detect_scoring(club, first_key)
        ev['dates'] = sorted(ev['dates'])

    result = {
        'club': club,
        'club_name': club_name,
        'events': list(events.values()),
    }

    print(f'\n=== Discovery Summary ===')
    print(f'Club: {club_name} ({club})')
    for ev in result['events']:
        print(f'\n  {ev["name"]} [{ev["scoring"].upper()}]')
        print(f'    Dates: {", ".join(ev["dates"])}')
        for sess in ev['sessions']:
            print(f'    - {sess["title"]} ({sess["event_key"]}, {sess["boards"]} boards)')

    print(f'\n{json.dumps(result, default=list)}')
    return result


# ── CLI ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Scrape a BridgeWebs event into Supabase.'
    )
    parser.add_argument('url', help='BridgeWebs results URL')
    parser.add_argument('--dry-run', action='store_true',
                        help='Validate and parse without writing to database')
    parser.add_argument('--discover', action='store_true',
                        help='Discover all events and sessions without scraping')
    args = parser.parse_args()

    try:
        if args.discover:
            discover_club(args.url)
        else:
            tid = scrape(args.url, dry_run=args.dry_run)
            if tid and not args.dry_run:
                print(f'TOURNAMENT_ID:{tid}')
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f'FATAL: {e}', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
