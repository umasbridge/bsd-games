#!/usr/bin/env python3
"""
Scraper for BBO My Hands (bridgebase.com/myhands).

Logs into BBO (credentials from .env: BBO_USERNAME / BBO_PASSWORD), fetches
all hands a user played in a time window, groups them into sessions, and
imports the selected session(s) into Supabase bg_ tables.

Session grouping:
  - Tourney hands: grouped by tournament instance id (from traveller links)
  - Casual (MBC) / team hands: grouped by table lineup, split on 2h+ gaps

Each imported session becomes one tournament → one event → one stage.
The full LIN (deal, bidding with alerts, play) is embedded in the hands page.
By default the traveller page is fetched for each board too, storing every
table's result (each with its own LIN). Tourney travellers also provide the
real tournament name (which reveals IMP vs MP scoring) and your placement.
Use --no-travellers to store only your own table's results.

The .env login (BBO_USERNAME/BBO_PASSWORD) is only the account used to access
the site — hands can be fetched for ANY BBO user.

Usage:
    python3 scrapers/bbo.py                            # prompts for user + dates
    python3 scrapers/bbo.py --user someone --start 2026-07-15 --end 2026-07-16
    python3 scrapers/bbo.py "<myhands url>"            # paste a URL directly

Options: [--list] [--session N[,M]] [--all] [--dry-run] [--no-travellers]
"""

import argparse
import datetime
import html as html_lib
import http.cookiejar
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

from utils import (
    load_env, hand_hcp, compute_dd, contract_display,
    dealer_from_board, vulnerability_from_board,
)

load_env()

from db import (
    upsert_tournament, upsert_event, insert_stage,
    insert_participants, insert_boards, insert_board_results, stage_exists,
)

BASE = 'https://www.bridgebase.com'
LOGIN_URL = f'{BASE}/myhands/myhands_login.php'

SESSION_GAP_SECONDS = 2 * 3600

RANKS = 'AKQJT98765432'
LIN_DEALER_MAP = {'1': 'S', '2': 'W', '3': 'N', '4': 'E'}
LIN_VUL_MAP = {'o': 'none', 'n': 'ns', 'e': 'ew', 'b': 'both'}
SUIT_SYMBOLS = {'♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C'}


# ── HTTP fetching ─────────────────────────────────────────────────

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_opener = None

def _get_opener():
    global _opener
    if _opener is None:
        jar = http.cookiejar.CookieJar()
        _opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=_ssl_ctx),
        )
    return _opener


def fetch(url, data=None):
    """GET (or POST if data given). Returns (body, final_url)."""
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    with _get_opener().open(req) as resp:
        return resp.read().decode('utf-8', 'replace'), resp.geturl()


def _js_tz_offset():
    """Timezone offset in JS getTimezoneOffset() convention (minutes behind UTC)."""
    offset = datetime.datetime.now().astimezone().utcoffset()
    return -int(offset.total_seconds() // 60)


def fetch_hands_html(url):
    """Fetch a myhands hands.php page, handling login and the tz-offset form."""
    body, final_url = fetch(url)

    if 'myhands_login' in final_url or 'name="password"' in body:
        user = os.environ.get('BBO_USERNAME')
        pwd = os.environ.get('BBO_PASSWORD')
        if not user or not pwd:
            raise ValueError('BBO_USERNAME / BBO_PASSWORD not set. Add them to .env.')
        parsed = urllib.parse.urlparse(url)
        target = f'{parsed.path}?{parsed.query}' if parsed.query else parsed.path
        body, final_url = fetch(LOGIN_URL, {
            't': target, 'count': '1', 'username': user, 'password': pwd,
            'keep': 'on', 'submit': 'Login',
        })
        if 'name="password"' in body:
            raise ValueError('BBO login failed — check BBO_USERNAME / BBO_PASSWORD in .env')

    if 'tz_form' in body:
        body, final_url = fetch(url, {'offset': str(_js_tz_offset())})

    return body


# ── HTML row parsing ──────────────────────────────────────────────

# "highlight" marks the queried user's own table on traveller pages
ROW_RE = re.compile(r'<tr class="(mbc|tourney|team|highlight)">(.*?)</tr>', re.S)
LIN_RE = re.compile(r"hv_popuplin\('((?:[^'\\]|\\.)*)'")
MYHAND_RE = re.compile(r'myhand=M-(\d+)-(\d+)')
FETCHLIN_RE = re.compile(r'fetchlin\.php\?id=(\d+)&when_played=(\d+)')
TRAVELLER_RE = re.compile(r'traveller=([^"&]+)')


def _cell(row_html, cls):
    m = re.search(rf'<td class="{cls}">(.*?)</td>', row_html, re.S)
    return m.group(1).strip() if m else ''


def clean_text(cell_html):
    """Strip tags, unescape entities, map suit symbols to letters."""
    text = re.sub(r'<[^>]+>', '', cell_html)
    text = html_lib.unescape(text)
    for sym, letter in SUIT_SYMBOLS.items():
        text = text.replace(sym, letter)
    return text.strip()


def _parse_number(text):
    text = clean_text(text).replace(',', '')
    if not text or text in ('-', '&nbsp;'):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_hands_html(body):
    """Parse hand rows from a hands.php page. Returns list of hand dicts."""
    hands = []
    for kind, row_html in ROW_RE.findall(body):
        m = MYHAND_RE.search(row_html) or FETCHLIN_RE.search(row_html)
        epoch = int(m.group(2)) if m else 0

        lin = None
        lm = LIN_RE.search(row_html)
        if lm:
            lin = urllib.parse.unquote(lm.group(1)).replace("\\'", "'")

        tm = TRAVELLER_RE.search(row_html)
        traveller = urllib.parse.unquote(tm.group(1)) if tm else ''

        scores = re.findall(r'<td class="(?:neg)?score">(.*?)</td>', row_html, re.S)

        hands.append({
            'kind': kind,
            'epoch': epoch,
            'handnum': clean_text(_cell(row_html, 'handnum')),
            'north': clean_text(_cell(row_html, 'north')),
            'south': clean_text(_cell(row_html, 'south')),
            'east': clean_text(_cell(row_html, 'east')),
            'west': clean_text(_cell(row_html, 'west')),
            'result_text': clean_text(_cell(row_html, 'result')),
            'points': _parse_number(scores[0]) if len(scores) > 0 else None,
            'score_value': _parse_number(scores[1]) if len(scores) > 1 else None,
            'traveller': traveller,
            'lin': lin,
        })
    return hands


# ── Traveller pages ───────────────────────────────────────────────

def fetch_traveller(traveller_param, username):
    """Fetch a traveller page: all tables' results for one deal.

    Returns (rows, summary). Rows use the same shape as parse_hands_html.
    In traveller pages the points/score columns are from the EW perspective
    (the page header reads "EW Points"). summary is only present on tourney
    travellers: {'name', 'place', 'total'} for the tournament.
    """
    url = (f'{BASE}/myhands/hands.php'
           f'?traveller={urllib.parse.quote(traveller_param, safe="")}'
           f'&username={urllib.parse.quote(username)}')
    body = fetch_hands_html(url)
    rows = parse_hands_html(body)

    summary = None
    m = re.search(r'<tr class="tourneySummary">(.*?)</tr>', body, re.S)
    if m:
        seg = m.group(1)
        name = re.search(r'<td class="tourneyName"[^>]*>(.*?)</td>', seg, re.S)
        place = re.search(r'<td class="tourneyPlace"[^>]*>(.*?)</td>', seg, re.S)
        total = re.search(r'<td class="tourneyScore[^"]*"[^>]*>(.*?)</td>', seg, re.S)
        summary = {
            'name': clean_text(name.group(1)) if name else None,
            'place': clean_text(place.group(1)) if place else None,
            'total': _parse_number(total.group(1)) if total else None,
        }
    return rows, summary


# ── Result string parsing ─────────────────────────────────────────

RESULT_RE = re.compile(r'^([1-7])(N|S|H|D|C)T?(XX|X)?([NSEW])(=|[+-]\d+)$')


def parse_result(text):
    """Parse a result string like '4DS-3', '3NS-1', '1NW=', '2SXE-1', 'PASS'.

    Returns dict with contract fields, or {'passed_out': True}, or None.
    """
    if not text:
        return None
    text = text.replace(' ', '').upper()
    if text.startswith('PASS'):
        return {'passed_out': True}
    m = RESULT_RE.match(text)
    if not m:
        return None
    level = int(m.group(1))
    denom = 'NT' if m.group(2) == 'N' else m.group(2)
    x = m.group(3)
    declarer = m.group(4)
    delta = 0 if m.group(5) == '=' else int(m.group(5))
    return {
        'passed_out': False,
        'level': level, 'denom': denom, 'x': x, 'declarer': declarer,
        'tricks': level + 6 + delta, 'overtricks': delta,
    }


# ── LIN parsing ───────────────────────────────────────────────────

def _split_hand(hand_str):
    """Split 'SAKJ5HQT3DK84C962' into [spades, hearts, diamonds, clubs]."""
    m = re.match(r'^S([^HDC]*)H([^DC]*)D([^C]*)C(.*)$', hand_str or '')
    if not m:
        return ['', '', '', '']
    return [m.group(1), m.group(2), m.group(3), m.group(4)]


def _complete_fourth_hand(suits_by_hand):
    """Given 3 hands' suits, derive the 4th from the remaining cards."""
    fourth = []
    for suit_idx in range(4):
        used = set()
        for hand in suits_by_hand:
            used.update(hand[suit_idx])
        fourth.append(''.join(r for r in RANKS if r not in used))
    return fourth


def parse_lin_fields(lin):
    """Extract board number, dealer, vul, hands, players, lead from a LIN string."""
    if not lin:
        return {}
    tokens = lin.split('|')
    tags = list(zip(tokens[0::2], tokens[1::2]))

    fields = {}
    first_card = None
    for tag, value in tags:
        if tag == 'ah' and 'board_number' not in fields:
            m = re.search(r'(\d+)', value)
            if m:
                fields['board_number'] = int(m.group(1))
        elif tag == 'sv' and 'vulnerability' not in fields:
            fields['vulnerability'] = LIN_VUL_MAP.get(value.lower())
        elif tag == 'pn' and 'players' not in fields:
            names = value.split(',')
            # pn| order is S, W, N, E
            fields['players'] = dict(zip(['S', 'W', 'N', 'E'], names + [''] * 4))
        elif tag == 'md' and 'hands' not in fields:
            fields['dealer'] = LIN_DEALER_MAP.get(value[:1])
            hand_strs = value[1:].split(',')
            suits = [_split_hand(h) for h in hand_strs[:4]]
            while len(suits) < 4:
                suits.append(['', '', '', ''])
            # md| hand order is S, W, N, E; a missing 4th hand is derivable
            if not any(suits[3]) and all(any(s) for s in suits[:3]):
                suits[3] = _complete_fourth_hand(suits[:3])
            hands = {}
            for dir_letter, hand_suits in zip(['s', 'w', 'n', 'e'], suits):
                for suit_name, holding in zip(['spades', 'hearts', 'diamonds', 'clubs'], hand_suits):
                    hands[f'{dir_letter}_{suit_name}'] = holding
            fields['hands'] = hands
        elif tag == 'pc' and first_card is None:
            first_card = value.strip().upper()

    if first_card and len(first_card) >= 2 and first_card[0] in 'SHDC':
        fields['lead_suit'] = first_card[0]
        fields['lead_rank'] = 'T' if first_card[1:] == '10' else first_card[1:]
        fields['lead'] = fields['lead_suit'] + fields['lead_rank']
    return fields


# ── Session grouping ──────────────────────────────────────────────

def _pair_key(a, b):
    return frozenset([a.lower(), b.lower()])


def _lineup_key(hand):
    return frozenset([
        _pair_key(hand['north'], hand['south']),
        _pair_key(hand['east'], hand['west']),
    ])


def _partner_of(username, hand):
    u = username.lower()
    for a, b in [('north', 'south'), ('south', 'north'), ('east', 'west'), ('west', 'east')]:
        if hand[a].lower() == u:
            return hand[b]
    return '?'


KIND_LABELS = {'mbc': 'Casual', 'tourney': 'Tourney', 'team': 'Team'}


def _make_session(kind, key, hand_list, username):
    hand_list.sort(key=lambda h: h['epoch'])
    first = hand_list[0]
    dt = datetime.datetime.fromtimestamp(first['epoch'])
    partner = _partner_of(username, first)
    label = f'BBO {KIND_LABELS[kind]} {dt:%Y-%m-%d %H:%M} ({username} & {partner})'
    return {
        'kind': kind,
        'key': key,
        'label': label,
        'date': f'{dt:%Y-%m-%d}',
        'partner': partner,
        'hands': hand_list,
    }


def group_sessions(hands, username):
    """Group hands into sessions: tourneys by instance id, casual by lineup + time gap."""
    tourney_groups = {}
    casual = []
    for h in hands:
        if h['kind'] == 'tourney':
            key = '-'.join(h['traveller'].split('-')[:2])
            tourney_groups.setdefault(key, []).append(h)
        else:
            casual.append(h)

    sessions = [_make_session('tourney', key, hs, username)
                for key, hs in tourney_groups.items()]

    casual.sort(key=lambda h: h['epoch'])
    open_groups = {}  # (kind, lineup) -> list of hands
    for h in casual:
        gk = (h['kind'], _lineup_key(h))
        group = open_groups.get(gk)
        if group and h['epoch'] - group[-1]['epoch'] <= SESSION_GAP_SECONDS:
            group.append(h)
        else:
            if group:
                sessions.append(_make_session(gk[0], f'{gk[0]}-{group[0]["epoch"]}', group, username))
            open_groups[gk] = [h]
    for gk, group in open_groups.items():
        sessions.append(_make_session(gk[0], f'{gk[0]}-{group[0]["epoch"]}', group, username))

    sessions.sort(key=lambda s: s['hands'][0]['epoch'])
    return sessions


# ── Import a session into the DB ──────────────────────────────────

def _build_participants(table_rows, username, event_id):
    """One participant per distinct pair; the queried user's pair is #1."""
    u = username.lower()
    pairs = {}  # pair_key -> display names
    for h in table_rows:
        for a, b in [('north', 'south'), ('east', 'west')]:
            pairs.setdefault(_pair_key(h[a], h[b]), (h[a], h[b]))

    def is_own(pk):
        return u in pk

    ordered = sorted(pairs.keys(), key=lambda pk: (not is_own(pk), sorted(pk)))
    rows = []
    pair_numbers = {}
    for i, pk in enumerate(ordered):
        a, b = pairs[pk]
        if b.lower() == u:
            a, b = b, a
        rows.append({
            'event_id': event_id,
            'number': i + 1,
            'name': f'{a} & {b}',
            'roster': [{'name': a, 'player_id': a}, {'name': b, 'player_id': b}],
        })
        pair_numbers[pk] = i + 1
    return rows, pair_numbers


def _result_row_from_table(row, *, ns_perspective_is_row_user, username, scoring,
                           stage_id, participant_map, pair_numbers,
                           bn, round_val, table_number):
    """Build one bg_board_results row from one table's row.

    ns_perspective_is_row_user: True when points/score are from the queried
    user's side (main hands list); False when they are from the EW side
    (traveller pages — their header reads "EW Points").
    """
    res = parse_result(row['result_text'])
    lf = parse_lin_fields(row['lin'])

    if ns_perspective_is_row_user:
        u = username.lower()
        side_is_ns = u in (row['north'].lower(), row['south'].lower())
    else:
        side_is_ns = False

    raw = row['points'] or 0
    ns_score = int(raw if side_is_ns else -raw)

    sv = row['score_value']
    imps_ns = imps_ew = mp_ns = mp_ew = None
    if sv is not None:
        if scoring == 'imp':
            imps_ns = sv if side_is_ns else -sv
            imps_ew = -imps_ns
        else:
            if side_is_ns:
                mp_ns = sv
            else:
                mp_ew = sv

    contract = None
    warning = None
    if res and not res.get('passed_out'):
        contract = contract_display(res['level'], res['denom'], res.get('x'))
    elif res is None and row['result_text']:
        warning = f'Board {bn}: unparsed result "{row["result_text"]}"'

    return {
        'board_id': None, '_board_number': bn, '_round': round_val,
        'stage_id': stage_id,
        'ns_participant_id': participant_map.get(pair_numbers.get(_pair_key(row['north'], row['south']))),
        'ew_participant_id': participant_map.get(pair_numbers.get(_pair_key(row['east'], row['west']))),
        'match_id': None,
        'contract': contract,
        'contract_level': res.get('level') if res else None,
        'contract_denom': res.get('denom') if res else None,
        'contract_x': res.get('x') if res else None,
        'declarer': res.get('declarer') if res else None,
        'passed_out': bool(res and res.get('passed_out')),
        'lead': lf.get('lead'), 'lead_suit': lf.get('lead_suit'), 'lead_rank': lf.get('lead_rank'),
        'tricks': res.get('tricks') if res else None,
        'overtricks': res.get('overtricks') if res else None,
        'score': ns_score,
        'mp_ns': mp_ns, 'mp_ew': mp_ew,
        'imps_ns': imps_ns, 'imps_ew': imps_ew,
        'datum_ns': None, 'datum_ew': None,
        'room': None, 'round': round_val, 'table_number': table_number,
        'player_n_name': row['north'], 'player_n_id': row['north'],
        'player_s_name': row['south'], 'player_s_id': row['south'],
        'player_e_name': row['east'], 'player_e_id': row['east'],
        'player_w_name': row['west'], 'player_w_id': row['west'],
        'lin': row['lin'],
        'remarks': None if res else (row['result_text'] or None),
    }, warning


def import_session(sess, username, source_url, dry_run=False, travellers=True, name=None):
    kind = sess['kind']
    event_type = 'teams' if kind == 'team' else 'pairs'

    # Key is user-independent (tourney instance id / first-hand epoch), so the
    # same session fetched via a different user's hands list is still skipped
    stage_url = f'{BASE}/myhands/hands.php#bbo-{sess["key"]}'
    if not dry_run and stage_exists(stage_url):
        print(f'  Already imported: {sess["label"]}. Skipping.')
        return

    # Fetch travellers: every table's result (with LIN) for each board
    trav_rows = {}  # hand index -> traveller rows
    summary = None
    if travellers:
        print(f'  Fetching travellers for {sess["label"]}...')
        for i, h in enumerate(sess['hands']):
            if not h['traveller']:
                continue
            try:
                rows, s = fetch_traveller(h['traveller'], username)
            except Exception as e:
                print(f'    Traveller fetch failed for hand {i + 1}: {e}')
                continue
            if rows:
                trav_rows[i] = rows
            if s and s.get('name') and not summary:
                summary = s
            if (i + 1) % 6 == 0 or i == len(sess['hands']) - 1:
                print(f'    {i + 1}/{len(sess["hands"])} travellers fetched')

    # Scoring and name: tourney travellers carry the real tournament name,
    # which also reveals IMP vs matchpoint scoring
    scoring = 'imp'
    label = sess['label']
    if kind == 'tourney':
        scoring = 'mp'
        if summary and summary.get('name'):
            scoring = 'imp' if re.search(r'\bIMPs?\b', summary['name'], re.I) else 'mp'
            label = f'{summary["name"]} {sess["date"]}'
    if name and name.strip():
        label = name.strip()

    tournament_data = {
        'name': label,
        'date_start': sess['date'],
        'source_format': 'bbo',
        'source_meta': {'kind': kind, 'session_key': sess['key'], 'username': username},
    }

    stage_meta = {'session_key': sess['key'], 'source_page': source_url}
    if summary:
        stage_meta['place'] = summary.get('place')
        stage_meta['total_score'] = summary.get('total')

    if dry_run:
        tournament_id, event_id, stage_id = 'dry-t', 'dry-e', 'dry-s'
    else:
        tournament_id = upsert_tournament(tournament_data)
        event_id = upsert_event({
            'tournament_id': tournament_id,
            'name': 'Main',
            'type': event_type,
            'scoring': scoring,
            'source_meta': {},
        })
        stage_id = insert_stage({
            'event_id': event_id,
            'name': 'Session',
            'boards_per_round': len(sess['hands']),
            'number_of_rounds': 1,
            'source_url': stage_url,
            'source_meta': stage_meta,
        })

    # Table rows per board: traveller rows (whole field, includes our own
    # table) when available, else just our own row from the hands list
    tables_by_hand = []
    for i, h in enumerate(sess['hands']):
        if trav_rows.get(i):
            tables_by_hand.append((h, trav_rows[i], False))
        else:
            tables_by_hand.append((h, [h], True))

    all_table_rows = [row for _, rows, _ in tables_by_hand for row in rows]
    participant_rows, pair_numbers = _build_participants(all_table_rows, username, event_id)
    if dry_run:
        participant_map = {r['number']: f'dry-p{r["number"]}' for r in participant_rows}
    else:
        participant_map = insert_participants(participant_rows)

    board_rows, result_rows = [], []
    seen_boards = {}
    dd_missing = False
    warnings = []

    for i, (h, rows, own_perspective) in enumerate(tables_by_hand):
        lf = parse_lin_fields(h['lin'])
        bn = lf.get('board_number') or (i + 1)
        seen_boards[bn] = seen_boards.get(bn, 0) + 1
        round_val = None if seen_boards[bn] == 1 else seen_boards[bn]

        hands16 = lf.get('hands') or {}
        dealer = lf.get('dealer') or dealer_from_board(bn)
        vul = lf.get('vulnerability') or vulnerability_from_board(bn)

        hcp = {}
        for d in ['n', 'e', 's', 'w']:
            hcp[f'hcp_{d}'] = hand_hcp(
                hands16.get(f'{d}_spades', ''), hands16.get(f'{d}_hearts', ''),
                hands16.get(f'{d}_diamonds', ''), hands16.get(f'{d}_clubs', ''),
            )

        board_row = {
            'stage_id': stage_id,
            'board_number': bn,
            'round': round_val,
            'dealer': dealer,
            'vulnerability': vul,
            **{f'{d}_{s}': hands16.get(f'{d}_{s}', '') for d in 'nesw'
               for s in ['spades', 'hearts', 'diamonds', 'clubs']},
            **hcp,
            'minimax': None,
            'optimal_score': None,
        }
        dd = compute_dd(board_row)
        if dd:
            board_row.update(dd)
        else:
            dd_missing = True
        board_rows.append(board_row)

        for row in rows:
            result_row, warning = _result_row_from_table(
                row,
                ns_perspective_is_row_user=own_perspective,
                username=username, scoring=scoring, stage_id=stage_id,
                participant_map=participant_map, pair_numbers=pair_numbers,
                bn=bn, round_val=round_val,
                table_number=(row['handnum'] or None) if not own_perspective else None,
            )
            result_rows.append(result_row)
            if warning:
                warnings.append(warning)

    if dry_run:
        print(f'  [DRY RUN] {label}')
        print(f'    {len(participant_rows)} pairs, {len(board_rows)} boards, {len(result_rows)} results '
              f'({event_type}/{scoring})')
    else:
        board_id_map = insert_boards(board_rows)
        for r in result_rows:
            bn = r.pop('_board_number')
            rnd = r.pop('_round')
            r['board_id'] = board_id_map.get((rnd, bn))
        result_rows = [r for r in result_rows if r.get('board_id')]
        insert_board_results(result_rows)
        print(f'  Imported: {label}')
        print(f'    {len(participant_rows)} pairs, {len(board_rows)} boards, {len(result_rows)} results '
              f'({event_type}/{scoring})')
    if summary and summary.get('place'):
        print(f'    Finished {summary["place"]}, total {summary.get("total")}')

    if dd_missing:
        print('    Note: double-dummy not computed (endplay not installed)')
    for w in warnings[:10]:
        print(f'    Warning: {w}')
    if len(warnings) > 10:
        print(f'    ... and {len(warnings) - 10} more warnings')


# ── CLI ───────────────────────────────────────────────────────────

def session_summary(sess):
    """JSON-safe summary of a session (for API/UI listing)."""
    opponents = ''
    if sess['kind'] != 'tourney':
        h = sess['hands'][0]
        u = sess['partner'].lower()
        pairs = [(h['north'], h['south']), (h['east'], h['west'])]
        opp = next((p for p in pairs if u not in (p[0].lower(), p[1].lower())), None)
        if opp:
            opponents = f'{opp[0]} & {opp[1]}'
    return {
        'key': sess['key'],
        'label': sess['label'],
        'kind': sess['kind'],
        'boards': len(sess['hands']),
        'opponents': opponents,
    }


def _print_sessions(sessions):
    print(f'\nFound {len(sessions)} sessions:')
    for i, s in enumerate(sessions):
        info = session_summary(s)
        opponents = f' vs {info["opponents"]}' if info['opponents'] else ''
        print(f'  [{i + 1}] {s["label"]}{opponents} — {len(s["hands"])} boards')


def _date_to_epoch(date_str):
    """'YYYY-MM-DD' → local-midnight unix timestamp."""
    return int(datetime.datetime.strptime(date_str, '%Y-%m-%d').timestamp())


def build_url(username, start_date, end_date=None):
    """Build a myhands hands.php URL for a user and an inclusive date range."""
    end_date = end_date or start_date
    start_time = _date_to_epoch(start_date)
    end_time = _date_to_epoch(end_date) + 24 * 3600
    return (f'{BASE}/myhands/hands.php'
            f'?username={urllib.parse.quote(username)}'
            f'&start_time={start_time}&end_time={end_time}')


def _resolve_target(args):
    """Determine whose hands to fetch and for which dates. Returns (url, username).

    The BBO login (.env) is just the account used to access the site — hands
    can be fetched for any BBO user.
    """
    if args.url:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(args.url).query)
        username = (query.get('username') or [''])[0]
        if not username:
            print('ERROR: URL must contain a username= parameter', file=sys.stderr)
            sys.exit(1)
        return args.url, username

    username = args.user
    if not username and sys.stdin.isatty():
        username = input('Fetch hands for which BBO user? ').strip()
    if not username:
        print('ERROR: no user given. Pass --user (and --start/--end), or a myhands URL.',
              file=sys.stderr)
        sys.exit(1)

    start = args.start
    end = args.end
    if not start and sys.stdin.isatty():
        start = input('From date (YYYY-MM-DD): ').strip()
    if not start:
        print('ERROR: no start date given. Pass --start YYYY-MM-DD.', file=sys.stderr)
        sys.exit(1)
    if not end and sys.stdin.isatty():
        end = input(f'To date (YYYY-MM-DD, inclusive) [{start}]: ').strip() or start

    return build_url(username, start, end), username


def main():
    parser = argparse.ArgumentParser(description='Scrape BBO My Hands into Supabase.')
    parser.add_argument('url', nargs='?',
                        help='BBO myhands URL (hands.php?username=...&start_time=...&end_time=...). '
                             'Omit to be prompted, or use --user/--start/--end.')
    parser.add_argument('--user', help='BBO username whose hands to fetch (any user, not just the login)')
    parser.add_argument('--start', help='From date, YYYY-MM-DD')
    parser.add_argument('--end', help='To date, YYYY-MM-DD (inclusive; defaults to --start)')
    parser.add_argument('--list', action='store_true', help='List detected sessions and exit')
    parser.add_argument('--session', help='Import session number(s), e.g. 2 or 1,3')
    parser.add_argument('--all', action='store_true', help='Import all sessions')
    parser.add_argument('--dry-run', action='store_true', help='Parse without writing to database')
    parser.add_argument('--no-travellers', action='store_true',
                        help='Skip traveller pages (only import own table results)')
    args = parser.parse_args()

    url, username = _resolve_target(args)

    print(f'Fetching hands for {username}...')
    body = fetch_hands_html(url)
    hands = parse_hands_html(body)
    print(f'  {len(hands)} hands found')
    if not hands:
        return

    sessions = group_sessions(hands, username)
    _print_sessions(sessions)

    if args.list:
        return

    if args.all:
        selected = list(range(1, len(sessions) + 1))
    elif args.session:
        selected = [int(x) for x in args.session.replace(' ', '').split(',')]
    elif sys.stdin.isatty():
        answer = input('\nImport which sessions? (e.g. 1,3 or all): ').strip().lower()
        if not answer:
            return
        selected = (list(range(1, len(sessions) + 1)) if answer == 'all'
                    else [int(x) for x in answer.replace(' ', '').split(',')])
    else:
        print('\nNo selection. Re-run with --session N[,M] or --all.')
        return

    print()
    for n in selected:
        if not 1 <= n <= len(sessions):
            print(f'  Skipping invalid session number {n}')
            continue
        import_session(sessions[n - 1], username, url, dry_run=args.dry_run,
                       travellers=not args.no_travellers)

    print('\nDone!')


if __name__ == '__main__':
    main()
