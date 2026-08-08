#!/usr/bin/env python3
"""
Scraper for LoveBridge vugraph format (vugraph.lovebridge.com).

Scrapes tournament data from the LoveBridge archive API and writes
structured data to Supabase bg_ tables.

Hierarchy: bg_tournaments → bg_events → bg_stages → bg_boards → bg_board_results

Usage:
    python3 scrapers/lovebridge.py <url_or_session_id> [--dry-run]

Examples:
    # By session URL
    python3 scrapers/lovebridge.py https://vugraph.lovebridge.com/screen/usbc_237963_2_1

    # By miniSessionId directly
    python3 scrapers/lovebridge.py usbc_237963_2_1
"""

import argparse
import json
import re
import ssl
import sys
import urllib.request

from utils import hand_hcp, contract_display, fill_dd
from lin import generate_lin
from db import (
    upsert_tournament, upsert_event, insert_stage, find_stage,
    insert_participants, find_participants,
    insert_boards, insert_board_results, stage_exists,
)

BASE_URL = 'https://vugraph.lovebridge.com'

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


# ── HTTP fetching ─────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json, text/plain, */*',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


def api(path):
    return fetch_json(f'{BASE_URL}{path}')


# ── URL / ID parsing ─────────────────────────────────────────────

def extract_session_id(url_or_id):
    """Extract miniSessionId from a URL or raw ID string.

    URL patterns:
      /screen/usbc_237963_2_1           → direct miniSessionId
      /screen/usbf/836399?...          → serverId/segmentId, need to look up
    """
    url_or_id = url_or_id.strip()

    # Pattern: /screen/{serverId}/{segmentId}
    m = re.search(r'/screen/([^/_?#]+)/(\d+)', url_or_id)
    if m:
        server_id = m.group(1)
        segment_id = m.group(2)
        return _lookup_session_by_server_segment(server_id, segment_id)

    # Pattern: /screen/{miniSessionId} (contains underscores)
    m = re.search(r'/screen/([^/?#]+_[^/?#]+)', url_or_id)
    if m:
        return m.group(1)

    # Raw ID like usbc_237963_2_1
    if '_' in url_or_id and not url_or_id.startswith('http'):
        return url_or_id

    raise ValueError(
        f'Cannot extract session ID from: {url_or_id}\n'
        f'Expected a URL like https://vugraph.lovebridge.com/screen/usbc_237963_2_1\n'
        f'or https://vugraph.lovebridge.com/screen/usbf/836399'
    )


def _lookup_session_by_server_segment(server_id, segment_id):
    """Look up miniSessionId from serverId + segmentId."""
    sessions = api('/api/archive/miniSessions')
    matches = [s for s in sessions
               if s.get('serverId') == server_id
               and str(s.get('segmentId')) == segment_id]
    if len(matches) == 1:
        return matches[0]['miniSessionId']
    if len(matches) > 1:
        print(f'  Found {len(matches)} sessions for {server_id}/{segment_id}:')
        for s in matches:
            print(f'    {s["miniSessionId"]}: {s.get("name", "")}')
        return matches[0]['miniSessionId']

    # Not in archive — probe for sessions
    found = []
    for session_num in range(1, 20):
        candidate = f'{server_id}_{segment_id}_{session_num}_1'
        try:
            boards = api(f'/api/archive/boards/{candidate}')
            played = len([b for b in boards if b.get('played')])
            if played > 0:
                found.append(candidate)
            else:
                break
        except Exception:
            break

    if not found:
        raise ValueError(f'No session found for server={server_id}, segment={segment_id}')

    if len(found) == 1:
        return found[0]

    return ','.join(found)


# ── Mapping constants ─────────────────────────────────────────────

VUL_MAP = {
    'NONE': 'none', 'NORTH_SOUTH': 'ns', 'EAST_WEST': 'ew', 'ALL': 'both',
}
DEALER_MAP = {
    'NORTH': 'N', 'EAST': 'E', 'SOUTH': 'S', 'WEST': 'W',
}
DENOM_MAP = {
    'CLUB': 'C', 'DIAMOND': 'D', 'HEART': 'H', 'SPADE': 'S', 'NT': 'NT',
}
BID_DENOM_MAP = {
    'C': 'C', 'D': 'D', 'H': 'H', 'S': 'S', 'N': 'NT',
}
CARD_VALUE_MAP = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
    9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}


# ── Parse session metadata into hierarchy ────────────────────────

def fetch_session(session_id):
    """Fetch the miniSession details from archive index or by probing."""
    sessions = api('/api/archive/miniSessions')
    for s in sessions:
        if s.get('miniSessionId') == session_id:
            return s

    try:
        boards = api(f'/api/archive/boards/{session_id}')
        if boards:
            parts = session_id.split('_')
            server_id = parts[0] if parts else session_id
            segment_id = parts[1] if len(parts) >= 2 else None
            played_count = len([b for b in boards if b.get('played')])
            bpr = played_count or len(boards)
            tournament_name = server_id.upper()

            # Default to TEAM/IMP for non-archived sessions
            event_type = 'TEAM'
            calc_type = 'IMP'
            type_label = 'Teams'

            return {
                'miniSessionId': session_id,
                'name': session_id,
                'tournamentName': tournament_name,
                'tournamentId': None,
                'eventName': f'{tournament_name} {type_label}',
                'eventId': segment_id,
                'eventOrder': None,
                'segmentName': f'Match ({bpr} boards)',
                'segmentId': segment_id,
                'segmentOrder': None,
                'type': event_type,
                'calcType': calc_type,
                'arrangeType': None,
                'location': '',
                'serverId': server_id,
                'boardsPerRound': bpr,
                'numberOfRounds': 1,
                'startDateTime': '',
            }
    except Exception:
        pass

    raise ValueError(f'Session {session_id} not found in archive.')


def build_tournament_data(session):
    """Build bg_tournaments row from miniSession."""
    return {
        'name': session.get('tournamentName') or 'Unknown',
        'location': session.get('location') or None,
        'date_start': session.get('startDateTime', '')[:10] or None,
        'source_format': 'lovebridge',
        'source_meta': {
            'tournament_id': session.get('tournamentId'),
            'server_id': session.get('serverId'),
        },
    }


def build_event_data(session, tournament_id):
    """Build bg_events row from miniSession."""
    tt = session.get('type', 'TEAM')
    calc = session.get('calcType', 'IMP')
    event_name = session.get('eventName') or session.get('segmentName') or 'Main'

    # For non-archived sessions, the eventName is already set to
    # "{SERVER} Teams" or "{SERVER} Pairs" by fetch_session fallback.
    # Only override if it still has the raw server_segment format.
    if not session.get('tournamentId') and event_name and '_' in event_name and event_name.count('_') >= 1:
        scoring_label = calc.upper() if calc else 'IMP'
        type_label = 'Teams' if tt == 'TEAM' else 'Pairs'
        tournament_name = session.get('tournamentName') or ''
        event_name = f'{tournament_name} {type_label}' if tournament_name else f'{type_label} ({scoring_label})'

    return {
        'tournament_id': tournament_id,
        'name': event_name,
        'type': 'teams' if tt == 'TEAM' else 'pairs',
        'scoring': calc.lower() if calc in ('IMP', 'MP', 'BAM') else 'imp',
        'event_order': session.get('eventOrder'),
        'source_meta': {
            'event_id': session.get('eventId'),
        },
    }


def build_stage_data(session, event_id, source_url):
    """Build bg_stages row from miniSession."""
    stage_name = session.get('segmentName') or session.get('name') or 'Main'
    # For non-archived sessions, segmentName is already set to "Match (N boards)"
    # by fetch_session fallback. No further transformation needed.

    return {
        'event_id': event_id,
        'name': stage_name,
        'stage_order': session.get('segmentOrder'),
        'arrange_type': session.get('arrangeType'),
        'boards_per_round': session.get('boardsPerRound'),
        'number_of_rounds': session.get('numberOfRounds'),
        'source_url': source_url,
        'source_meta': {
            'segment_id': session.get('segmentId'),
            'mini_session_id': session.get('miniSessionId'),
            'alert_type': session.get('alertType'),
        },
    }


# ── Parse registrations (participants) ────────────────────────────

def fetch_participants_data(session_id, event_id):
    """Fetch and parse teams/pairs. Returns (rows, reg_id_map)."""
    regs = api(f'/api/archive/registrations/{session_id}')

    short_names = {}
    try:
        teams = api(f'/api/archive/teams/{session_id}')
        for t in teams:
            rid = t.get('registrationId')
            tname = t.get('name', '')
            if rid and tname:
                short_names[rid] = _clean_html_entities(tname)
    except Exception:
        pass

    rows = []
    reg_id_map = {}
    for i, reg in enumerate(regs):
        reg_id = reg.get('registrationId') or reg.get('id')
        name = short_names.get(reg_id) or _clean_html_entities(reg.get('name', f'#{i+1}'))
        players = reg.get('players', [])
        roster = []
        for p in players:
            full = _clean_html_entities(f'{p.get("name", "")} {p.get("surname", "")}').strip()
            pid = p.get('playerId', '')
            roster.append({'name': full, 'player_id': str(pid)})

        number = i + 1
        rows.append({
            'event_id': event_id,
            'number': number,
            'name': name,
            'roster': roster,
        })
        reg_id_map[reg_id] = number

    return rows, reg_id_map


# ── Parse boards ──────────────────────────────────────────────────

def fetch_boards_data(session_id, stage_id):
    """Fetch all boards (hands + DD) for a session."""
    boards_data = api(f'/api/archive/boards/{session_id}')
    rows = []
    for b in boards_data:
        if not b.get('played'):
            continue

        bn = b.get('boardNumber', 0)
        dealer = DEALER_MAP.get(b.get('dealer', ''), 'N')
        vul = VUL_MAP.get(b.get('vulnerability', ''), 'none')

        hands = {}
        for direction in ['NORTH', 'EAST', 'SOUTH', 'WEST']:
            d = direction[0].lower()
            h = b.get('hands', {}).get(direction, ['', '', '', ''])
            hands[f'{d}_spades'] = h[0] if len(h) > 0 else ''
            hands[f'{d}_hearts'] = h[1] if len(h) > 1 else ''
            hands[f'{d}_diamonds'] = h[2] if len(h) > 2 else ''
            hands[f'{d}_clubs'] = h[3] if len(h) > 3 else ''

        hcp = {}
        for d in ['n', 'e', 's', 'w']:
            hcp[f'hcp_{d}'] = hand_hcp(
                hands[f'{d}_spades'], hands[f'{d}_hearts'],
                hands[f'{d}_diamonds'], hands[f'{d}_clubs']
            )

        # LoveBridge publishes its own DD table (optimumScores.maxTricks)
        # but we ignore it — DD is always computed with endplay from the
        # hands (see fill_dd), the single source across all scrapers.
        dd = {f'dd_{d}_{k}': None
              for d in ['n', 'e', 's', 'w']
              for k in ['c', 'd', 'h', 's', 'nt']}

        optimal_score = b.get('optimumScores', {}).get('score')

        rows.append({
            'stage_id': stage_id,
            'board_number': bn,
            'round': None,
            'dealer': dealer,
            'vulnerability': vul,
            **hands,
            **hcp,
            **dd,
            'minimax': None,
            'optimal_score': optimal_score,
        })

    return rows


# ── Parse watch data (bidding + play) ─────────────────────────────

def parse_bidding_from_watch(events):
    """Extract bidding sequence from watch events."""
    full = next((e for e in events if e.get('tt') == 'FULL'), None)
    if not full:
        return []

    payload = full.get('payload', {})
    bg = payload.get('bg', [])

    bidding = []
    for bid_entry in bg:
        d = bid_entry.get('d', '')
        bv = bid_entry.get('bv', '')
        alert = bid_entry.get('al') == 't'
        expl = ''
        if alert and bid_entry.get('expl'):
            expl = ' '.join(bid_entry['expl'].values()).strip()

        if bv == 'P':
            bid = 'P'
        elif bv == 'D':
            bid = 'X'
        elif bv == 'R':
            bid = 'XX'
        elif len(bv) >= 2:
            suit = BID_DENOM_MAP.get(bv[0], bv[0])
            level = bv[1:]
            bid = f'{level}{suit}'
        else:
            bid = bv

        bidding.append({
            'dir': d, 'bid': bid,
            'alert': alert, 'explanation': expl or None,
        })

    return bidding


def parse_play_from_watch(events):
    """Extract play sequence from watch events."""
    full = next((e for e in events if e.get('tt') == 'FULL'), None)
    if not full:
        return []

    payload = full.get('payload', {})
    tr = payload.get('tr', [])

    tricks = []
    for trick_str in tr:
        parts = trick_str.split(',')
        if len(parts) < 6:
            continue
        leader = parts[0]
        winner = parts[5]
        cards = []
        for card_str in parts[1:5]:
            if len(card_str) < 3:
                continue
            d = card_str[0]
            suit = card_str[1]
            val = int(card_str[2:])
            rank = CARD_VALUE_MAP.get(val, str(val))
            cards.append({'dir': d, 'suit': suit, 'rank': rank})
        tricks.append({'leader': leader, 'cards': cards, 'winner': winner})

    return tricks


def parse_players_from_watch(events):
    """Extract player names from watch FULL event."""
    full = next((e for e in events if e.get('tt') == 'FULL'), None)
    if not full:
        return {}

    ps = full.get('payload', {}).get('ps', {})
    players = {}
    for d in ['N', 'E', 'S', 'W']:
        p = ps.get(d, {})
        first = p.get('name', '').strip()
        last = p.get('surname', '').strip()
        if last and first.endswith(last):
            name = first
        else:
            name = f'{first} {last}'.strip()
        pid = p.get('playerId', '')
        players[f'player_{d.lower()}_name'] = name or None
        players[f'player_{d.lower()}_id'] = str(pid) if pid else None

    return players


def parse_room_from_watch(events):
    """Extract room (open/closed) from watch FULL event."""
    full = next((e for e in events if e.get('tt') == 'FULL'), None)
    if not full:
        return None
    room = full.get('payload', {}).get('room', '')
    if room == 'OPEN':
        return 'open'
    elif room == 'CLOSED':
        return 'closed'
    return None


def parse_claim_from_watch(events):
    """Extract claim tricks from watch events."""
    claim = next((e for e in events if e.get('tt') == 'CLAIM'), None)
    if claim:
        return claim.get('payload', {}).get('tcount')
    return None


# ── Parse helpers ─────────────────────────────────────────────────

def _parse_contract_string(s):
    """Parse contract string like '5Cx', '3NT', '4Hxx' into components."""
    if not s:
        return None
    s = s.strip()
    m = re.match(r'^(\d)([CDHSN]T?)(x{0,2})$', s, re.IGNORECASE)
    if not m:
        return None
    level = int(m.group(1))
    denom_raw = m.group(2).upper()
    denom = 'NT' if denom_raw in ('NT', 'N') else DENOM_MAP.get(denom_raw, denom_raw)
    xx = m.group(3).lower()
    x = 'XX' if xx == 'xx' else ('X' if xx == 'x' else None)
    return {'level': level, 'denom': denom, 'x': x}


def _parse_lead_string(s):
    """Parse lead string like 'S8', 'HA', 'DT' into suit, rank, display."""
    if not s or len(s) < 2:
        return None, None, None
    suit = s[0].upper()
    if suit not in 'SHDC':
        return None, None, None
    rank = s[1:].upper()
    if rank == '10':
        rank = 'T'
    return suit, rank, s


def _clean_html_entities(s):
    """Clean &nbsp; and other HTML entities from strings."""
    if not s:
        return s
    return s.replace('&nbsp;', ' ').replace('&amp;', '&').strip()


# ── Fetch frequencies (all table results) ─────────────────────────

def fetch_frequencies(session_id, board_number, is_teams):
    """Fetch all table results for a board."""
    endpoint = 'team-frequencies' if is_teams else 'pair-frequencies'
    try:
        return api(f'/api/archive/{endpoint}/{session_id}/{board_number}')
    except Exception:
        return []


# ── Process frequency results ─────────────────────────────────────

def _make_result_row(bn, vul, dealer, hands, session_id, stage_id,
                     ns_part, ew_part, match_id, res_data, room, round_num,
                     table_number, player_name_map, freq_player_ids,
                     reg_id_for_watch, is_teams):
    """Build a single board result row from frequency data."""
    contract_raw = res_data.get('contract', '')
    lead_raw = res_data.get('lead', '')
    score = res_data.get('score', 0)
    result_val = res_data.get('result', 0)

    parsed = _parse_contract_string(contract_raw)
    if not parsed:
        return None

    contract_level = parsed['level']
    contract_denom = parsed['denom']
    contract_x = parsed['x']
    declarer = res_data.get('decl', res_data.get('declarer', ''))
    contract = contract_display(contract_level, contract_denom, contract_x)
    tricks = contract_level + 6 + result_val
    overtricks = result_val
    lead_suit, lead_rank, lead = _parse_lead_string(lead_raw)

    # LoveBridge scores are already from NS perspective
    ns_score = score

    imps_ns = res_data.get('imp') if is_teams else None
    mp_ns = res_data.get('points', {}).get('N-S') if not is_teams else None
    mp_ew = res_data.get('points', {}).get('E-W') if not is_teams else None

    players = {}
    ns_ids = freq_player_ids.get('ns', [])
    ew_ids = freq_player_ids.get('ew', [])
    if len(ns_ids) >= 2:
        players['player_n_name'] = player_name_map.get(ns_ids[0])
        players['player_n_id'] = str(ns_ids[0])
        players['player_s_name'] = player_name_map.get(ns_ids[1])
        players['player_s_id'] = str(ns_ids[1])
    if len(ew_ids) >= 2:
        players['player_e_name'] = player_name_map.get(ew_ids[0])
        players['player_e_id'] = str(ew_ids[0])
        players['player_w_name'] = player_name_map.get(ew_ids[1])
        players['player_w_id'] = str(ew_ids[1])

    bidding, play, claim_tricks = None, None, None
    if res_data.get('replay'):
        regs_to_try = [r for r in reg_id_for_watch if r] if isinstance(reg_id_for_watch, (list, tuple)) else ([reg_id_for_watch] if reg_id_for_watch else [])
        best_bidding, best_play, best_claim, best_wp = None, None, None, {}
        for try_reg in regs_to_try:
            try:
                watch = api(f'/api/archive/watch/{session_id}/{try_reg}/{bn}')
                watch_room = parse_room_from_watch(watch)
                if watch_room and watch_room != room:
                    continue
                wb = parse_bidding_from_watch(watch)
                wp_data = parse_play_from_watch(watch)
                wc = parse_claim_from_watch(watch)
                wp = parse_players_from_watch(watch)
                alert_count = sum(1 for b in (wb or []) if b.get('alert'))
                best_alert_count = sum(1 for b in (best_bidding or []) if b.get('alert'))
                if wb and (not best_bidding or alert_count > best_alert_count):
                    best_bidding, best_play, best_claim, best_wp = wb, wp_data, wc, wp
            except Exception:
                pass
        bidding, play, claim_tricks = best_bidding, best_play, best_claim
        for k, v in best_wp.items():
            if v:
                players[k] = v

    lin = generate_lin(
        dealer=dealer, vulnerability=vul, hands=hands,
        contract_level=contract_level, contract_denom=contract_denom,
        contract_x=contract_x, declarer=declarer,
        lead_suit=lead_suit, lead_rank=lead_rank, tricks=tricks,
        player_n=players.get('player_n_name'), player_e=players.get('player_e_name'),
        player_s=players.get('player_s_name'), player_w=players.get('player_w_name'),
        bidding=bidding, play=play, claim_tricks=claim_tricks,
    )

    return {
        'board_id': None, 'stage_id': stage_id, '_board_number': bn,
        'ns_participant_id': ns_part, 'ew_participant_id': ew_part,
        'match_id': match_id,
        'contract': contract, 'contract_level': contract_level,
        'contract_denom': contract_denom, 'contract_x': contract_x,
        'declarer': declarer, 'passed_out': False,
        'lead': lead, 'lead_suit': lead_suit, 'lead_rank': lead_rank,
        'tricks': tricks, 'overtricks': overtricks, 'score': ns_score,
        'mp_ns': mp_ns, 'mp_ew': mp_ew,
        'imps_ns': imps_ns, 'imps_ew': -imps_ns if imps_ns is not None else None,
        'datum_ns': None, 'datum_ew': None,
        'room': room, 'round': round_num,
        'table_number': table_number,
        **{k: players.get(k) for k in [
            'player_n_name', 'player_n_id', 'player_s_name', 'player_s_id',
            'player_e_name', 'player_e_id', 'player_w_name', 'player_w_id',
        ]},
        'lin': lin, 'remarks': None,
    }


def _process_team_freq(freq, bn, vul, dealer, hands, session_id,
                       reg_id_map, participant_map, player_name_map,
                       stage_id, result_rows, round_offset=None):
    home_reg = freq.get('registrations', {}).get('HOME')
    visit_reg = freq.get('registrations', {}).get('VISITING')
    home_num = reg_id_map.get(home_reg)
    visit_num = reg_id_map.get(visit_reg)
    home_part = participant_map.get(home_num)
    visit_part = participant_map.get(visit_num)

    ids = sorted([str(home_reg or 0), str(visit_reg or 0)])
    match_id = f'm{ids[0]}v{ids[1]}'
    round_num = round_offset if round_offset is not None else freq.get('round')
    table_num = freq.get('calculatedTableId')

    for room_key, room_label in [('openResult', 'open'), ('closedResult', 'closed')]:
        res = freq.get(room_key)
        if not res:
            continue

        if room_label == 'open':
            ns_part, ew_part = home_part, visit_part
        else:
            ns_part, ew_part = visit_part, home_part
        watch_reg = [home_reg, visit_reg]

        pids = {
            'ns': freq.get(f'{room_label}Ns', []),
            'ew': freq.get(f'{room_label}Ew', []),
        }

        row = _make_result_row(bn, vul, dealer, hands, session_id, stage_id,
                               ns_part, ew_part, match_id, res, room_label,
                               round_num, table_num, player_name_map, pids,
                               watch_reg, True)
        if row:
            result_rows.append(row)


def _process_pair_freq(freq, bn, vul, dealer, hands, session_id,
                       reg_id_map, participant_map, player_name_map,
                       stage_id, result_rows):
    regs = freq.get('registrations', {})
    ns_reg = regs.get('N-S')
    ew_reg = regs.get('E-W')
    ns_num = reg_id_map.get(ns_reg)
    ew_num = reg_id_map.get(ew_reg)
    ns_part = participant_map.get(ns_num)
    ew_part = participant_map.get(ew_num)

    res_data = {
        'contract': freq.get('contract', ''),
        'lead': freq.get('lead', ''),
        'score': freq.get('scores', {}).get('N-S', 0),
        'result': freq.get('result', 0),
        'decl': freq.get('declarer', ''),
        'replay': freq.get('replay', False),
        'points': freq.get('points', {}),
    }

    pids = {'ns': [], 'ew': []}

    row = _make_result_row(bn, vul, dealer, hands, session_id, stage_id,
                           ns_part, ew_part, None, res_data, None,
                           None, None, player_name_map, pids,
                           ns_reg, False)
    if row:
        result_rows.append(row)


# ── Scrape helpers ────────────────────────────────────────────────

def _build_player_name_map(participants):
    """Build playerId → name lookup from participant rosters."""
    player_name_map = {}
    for p in participants:
        for r in p.get('roster', []):
            pid = r.get('player_id', '')
            if pid and pid.isdigit():
                player_name_map[int(pid)] = r['name']
    return player_name_map


def _scrape_session_boards(session_id, stage_id, is_teams, round_offset,
                           reg_id_map, participant_map, player_name_map):
    """Scrape boards and results for a single miniSession. Returns (board_rows, result_rows, errors)."""
    board_rows = fetch_boards_data(session_id, stage_id)
    result_rows = []
    errors = []

    for i, board_row in enumerate(board_rows):
        bn = board_row['board_number']
        if round_offset is not None:
            board_row['round'] = round_offset
        vul = board_row['vulnerability']
        dealer = board_row['dealer']
        hands = {k: v for k, v in board_row.items()
                 if '_spades' in k or '_hearts' in k or '_diamonds' in k or '_clubs' in k}

        freqs = fetch_frequencies(session_id, bn, is_teams)

        for freq in freqs:
            try:
                if is_teams:
                    _process_team_freq(freq, bn, vul, dealer, hands, session_id,
                                       reg_id_map, participant_map, player_name_map,
                                       stage_id, result_rows, round_offset)
                else:
                    _process_pair_freq(freq, bn, vul, dealer, hands, session_id,
                                       reg_id_map, participant_map, player_name_map,
                                       stage_id, result_rows)
            except Exception as e:
                errors.append(f'Board {bn}: {e}')

        if (i + 1) % 5 == 0 or i == len(board_rows) - 1:
            print(f'  Processed board {i+1}/{len(board_rows)} ({len(result_rows)} results)')

    return board_rows, result_rows, errors


# ── Scrape a single stage ─────────────────────────────────────────

def _scrape_stage(session, session_ids, tournament_id, event_id, dry_run=False):
    """Scrape one stage (one or more miniSessions for the same segment)."""
    tt = session.get('type', 'TEAM')
    is_teams = tt == 'TEAM'

    source_url = f'{BASE_URL}/screen/{session_ids[0]}'
    if not dry_run and stage_exists(source_url):
        print(f'    Stage "{session.get("segmentName", "?")}" already scraped. Skipping.')
        return

    stage_data = build_stage_data(session, event_id, source_url)
    if len(session_ids) > 1:
        stage_data['source_meta']['session_ids'] = session_ids
        # Update stage name with total boards when multiple sessions are discovered
        bpr = session.get('boardsPerRound', 0)
        if bpr and not session.get('tournamentId'):
            total = bpr * len(session_ids)
            stage_data['name'] = f'Match ({total} boards, {len(session_ids)} segments)'
        stage_data['number_of_rounds'] = len(session_ids)

    if dry_run:
        stage_id = 'dry-run-s'
        print(f'    [DRY RUN] Stage: {stage_data["name"]}')
    else:
        stage_id = insert_stage(stage_data)
        print(f'    Stage: {stage_data["name"]} ({stage_id})')

    # Participants (linked to event — may already exist from another stage)
    if not dry_run:
        existing_parts = find_participants(event_id)
    else:
        existing_parts = {}

    if existing_parts:
        participant_map = existing_parts
        participants, reg_id_map = fetch_participants_data(session_ids[0], event_id)
    else:
        participants, reg_id_map = fetch_participants_data(session_ids[0], event_id)
        if dry_run:
            participant_map = {p['number']: f'id-{p["number"]}' for p in participants}
        else:
            participant_map = insert_participants(participants)
            print(f'    Inserted {len(participants)} participants')

    player_name_map = _build_player_name_map(participants)

    # Scrape boards and results from all sessions in this stage
    all_board_rows = []
    all_result_rows = []
    all_errors = []

    for seg_idx, sid in enumerate(session_ids):
        round_offset = seg_idx + 1 if len(session_ids) > 1 else None
        board_rows, result_rows, errors = _scrape_session_boards(
            sid, stage_id, is_teams, round_offset,
            reg_id_map, participant_map, player_name_map,
        )
        all_board_rows.extend(board_rows)
        all_result_rows.extend(result_rows)
        all_errors.extend(errors)

    if dry_run:
        print(f'    Boards: {len(all_board_rows)}, Results: {len(all_result_rows)}')
        return

    # Insert boards (DD always computed with endplay, single source)
    print(f'Computing DD for {len(all_board_rows)} boards...')
    fill_dd(all_board_rows)
    board_id_map = insert_boards(all_board_rows)

    for result in all_result_rows:
        bn = result.pop('_board_number')
        rnd = result.get('round')
        result['board_id'] = board_id_map.get((rnd, bn)) or board_id_map.get((None, bn))

    all_result_rows = [r for r in all_result_rows if r.get('board_id')]

    insert_board_results(all_result_rows)

    print(f'    {len(all_board_rows)} boards, {len(all_result_rows)} results')
    if all_errors:
        print(f'    Errors ({len(all_errors)}):')
        for e in all_errors[:5]:
            print(f'      {e}')


# ── Main scrape logic ─────────────────────────────────────────────

def scrape(url_or_id, dry_run=False, name=None):
    """Scrape an entire LoveBridge tournament from any session URL.

    Discovers all events and stages for the tournament, then scrapes each.
    Stages already in the DB are skipped (idempotent).
    """
    session_id = extract_session_id(url_or_id)

    # Handle comma-separated multi-session (from _lookup_session_by_server_segment)
    all_session_ids = session_id.split(',') if ',' in session_id else [session_id]
    first_session_id = all_session_ids[0]

    # 1. Fetch session metadata to identify the tournament
    print('Fetching session metadata...')
    session = fetch_session(first_session_id)
    tournament_name = name or session.get('tournamentName', '?')
    lb_tournament_id = session.get('tournamentId')

    print(f'  Tournament: {tournament_name}')

    # 2. Discover all sessions for this tournament from the archive index
    print('Discovering all events and stages...')
    all_sessions = api('/api/archive/miniSessions')
    tournament_sessions = [s for s in all_sessions
                           if s.get('tournamentId') == lb_tournament_id]

    if not tournament_sessions:
        # Fallback: build stub sessions for all discovered session IDs
        tournament_sessions = []
        for sid in all_session_ids:
            stub = dict(session)
            stub['miniSessionId'] = sid
            stub['name'] = sid
            tournament_sessions.append(stub)
        print(f'  Not in archive index — using {len(tournament_sessions)} probed sessions')

    # 3. Group sessions: tournament → events → stages (segments)
    events = {}
    for s in tournament_sessions:
        eid = s.get('eventId') or s.get('segmentId')
        if eid not in events:
            events[eid] = {'meta': s, 'segments': {}}
        seg_id = s.get('segmentId')
        if seg_id not in events[eid]['segments']:
            events[eid]['segments'][seg_id] = {'meta': s, 'sessions': []}
        events[eid]['segments'][seg_id]['sessions'].append(s)

    # Sort events by eventOrder, segments by segmentOrder
    sorted_events = sorted(events.values(), key=lambda e: e['meta'].get('eventOrder', 0))
    for ev in sorted_events:
        ev['sorted_segments'] = sorted(ev['segments'].values(),
                                       key=lambda s: s['meta'].get('segmentOrder', 0))

    # Print discovery summary
    total_stages = sum(len(e['segments']) for e in sorted_events)
    print(f'  Found {len(sorted_events)} events, {total_stages} stages:')
    for ev in sorted_events:
        em = ev['meta']
        stage_names = [sg['meta'].get('segmentName', '?') for sg in ev['sorted_segments']]
        print(f'    {em.get("eventName", "?")} ({em.get("type", "?")}/{em.get("calcType", "?")}): '
              f'{", ".join(stage_names)}')

    # 4. Create tournament
    tournament_data = build_tournament_data(session)
    if name:
        tournament_data['name'] = name
    if dry_run:
        print(f'\n[DRY RUN] Tournament: {tournament_data["name"]}')
        tournament_id = 'dry-run-t'
    else:
        tournament_id = upsert_tournament(tournament_data)
        print(f'\n  Tournament ID: {tournament_id}')

    # 5. Scrape each event → each stage
    total_boards = 0
    total_results = 0

    for ev in sorted_events:
        em = ev['meta']
        event_data = build_event_data(em, tournament_id)
        event_data['tournament_id'] = tournament_id

        event_name = event_data['name']
        print(f'\n  Event: {event_name} ({event_data["type"]}/{event_data["scoring"]})')

        if dry_run:
            event_id = 'dry-run-e'
        else:
            event_id = upsert_event(event_data)

        for sg in ev['sorted_segments']:
            sm = sg['meta']
            # Collect all miniSessionIds for this segment (multi-session stages)
            seg_session_ids = sorted(
                [s['miniSessionId'] for s in sg['sessions']],
                key=lambda sid: sid  # sort by ID for consistent ordering
            )

            _scrape_stage(sm, seg_session_ids, tournament_id, event_id, dry_run)

    print(f'\nDone! Tournament: {tournament_data["name"]}')
    return tournament_id


# ── CLI ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Scrape a LoveBridge tournament into Supabase.\n'
                    'Any session URL scrapes the ENTIRE tournament (all events and stages).'
    )
    parser.add_argument('url', help='LoveBridge URL or miniSessionId (any session from the tournament)')
    parser.add_argument('--name', help='Override tournament name')
    parser.add_argument('--dry-run', action='store_true',
                        help='Validate and parse without writing to database')
    args = parser.parse_args()

    try:
        tid = scrape(args.url, dry_run=args.dry_run, name=args.name)
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
