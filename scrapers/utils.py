"""Shared utilities for bridge game scrapers."""

# ── Double-dummy analysis ────────────────────────────────────────

def compute_dd(board_row):
    """Compute double-dummy tricks for a board row dict.

    Takes a dict with keys like n_spades, n_hearts, etc.
    Returns a dict with dd_n_c, dd_n_d, ..., dd_w_nt (20 keys),
    or None if hand data is incomplete.
    """
    try:
        from endplay.dds import calc_dd_table
        from endplay.types import Deal, Player, Denom
    except ImportError:
        return None

    dirs_order = ['n', 'e', 's', 'w']
    suits_order = ['spades', 'hearts', 'diamonds', 'clubs']

    hands = []
    for d in dirs_order:
        suit_holdings = []
        for s in suits_order:
            h = board_row.get(f'{d}_{s}', '') or ''
            suit_holdings.append(h)
        if not any(suit_holdings):
            return None
        hands.append('.'.join(suit_holdings))

    pbn = f'N:{" ".join(hands)}'
    deal = Deal(pbn)
    table = calc_dd_table(deal)

    denom_map = [
        ('c', Denom.clubs), ('d', Denom.diamonds),
        ('h', Denom.hearts), ('s', Denom.spades), ('nt', Denom.nt),
    ]
    player_map = [
        ('n', Player.north), ('e', Player.east),
        ('s', Player.south), ('w', Player.west),
    ]

    dd = {}
    for dk, denom in denom_map:
        for pk, player in player_map:
            dd[f'dd_{pk}_{dk}'] = table[denom, player]
    return dd


# ── Card / Hand helpers ───────────────────────────────────────────

HCP_VALUES = {'A': 4, 'K': 3, 'Q': 2, 'J': 1}

def compute_hcp(holding: str) -> int:
    """Compute high card points for a suit holding string like 'AKJ95'."""
    return sum(HCP_VALUES.get(c, 0) for c in holding)


def hand_hcp(spades: str, hearts: str, diamonds: str, clubs: str) -> int:
    """Compute total HCP for a hand given its four suit holdings."""
    return (compute_hcp(spades or '') + compute_hcp(hearts or '')
            + compute_hcp(diamonds or '') + compute_hcp(clubs or ''))


# ── Dealer / Vulnerability from board number ─────────────────────

DEALER_CYCLE = ['N', 'E', 'S', 'W']
VUL_CYCLE = ['none', 'ns', 'ew', 'both',   # boards 1-4
             'ns', 'ew', 'both', 'none',    # boards 5-8
             'ew', 'both', 'none', 'ns',    # boards 9-12
             'both', 'none', 'ns', 'ew']    # boards 13-16

def dealer_from_board(board_number: int) -> str:
    """Standard bridge dealer rotation: board 1=N, 2=E, 3=S, 4=W, repeating."""
    return DEALER_CYCLE[(board_number - 1) % 4]


def vulnerability_from_board(board_number: int) -> str:
    """Standard bridge vulnerability rotation (16-board cycle)."""
    return VUL_CYCLE[(board_number - 1) % 16]


# ── Srini format constants ────────────────────────────────────────

SRINI_DENOM_MAP = {0: 'C', 1: 'D', 2: 'H', 3: 'S', 4: 'NT'}
SRINI_DECL_MAP = {0: 'N', 1: 'S', 2: 'W', 3: 'E'}
SRINI_SUIT_MAP = {0: 'C', 1: 'D', 2: 'H', 3: 'S'}
SRINI_CARD_MAP = {
    0: '2', 1: '3', 2: '4', 3: '5', 4: '6', 5: '7',
    6: '8', 7: '9', 8: 'T', 9: 'J', 10: 'Q', 11: 'K', 12: 'A',
}
SRINI_VUL_MAP = {0: 'none', 1: 'ns', 2: 'ew', 3: 'both'}
SRINI_DEALER_MAP = {0: 'N', 1: 'E', 2: 'S', 3: 'W'}


# ── Contract display string ──────────────────────────────────────

def contract_display(level: int, denom: str, x: str = None) -> str:
    """Build display string like '4H', '3NTX', '6CXX'."""
    s = f'{level}{denom}'
    if x:
        s += x
    return s


# ── Score computation ─────────────────────────────────────────────

def compute_score(level: int, denom: str, declarer: str, tricks: int,
                  vulnerability: str, doubled: str = None) -> int:
    """Compute bridge score from contract details. Returns score from declarer's perspective."""
    if tricks is None or level is None:
        return 0

    needed = level + 6
    made = tricks >= needed
    vul = _is_declarer_vul(declarer, vulnerability)

    if not made:
        undertricks = needed - tricks
        if doubled == 'XX':
            return -_redoubled_undertrick_penalty(undertricks, vul)
        elif doubled == 'X':
            return -_doubled_undertrick_penalty(undertricks, vul)
        else:
            return -(undertricks * (100 if vul else 50))

    overtricks = tricks - needed

    if denom in ('C', 'D'):
        trick_score = level * 20
        ot_value = 20
    elif denom in ('H', 'S'):
        trick_score = level * 30
        ot_value = 30
    else:  # NT
        trick_score = 40 + (level - 1) * 30
        ot_value = 30

    if doubled == 'X':
        trick_score *= 2
    elif doubled == 'XX':
        trick_score *= 4

    is_game = trick_score >= 100
    is_slam = level == 6
    is_grand = level == 7

    score = trick_score

    if doubled == 'XX':
        score += overtricks * (400 if vul else 200)
    elif doubled == 'X':
        score += overtricks * (200 if vul else 100)
    else:
        score += overtricks * ot_value

    if is_grand:
        score += 1500 if vul else 1000
    elif is_slam:
        score += 750 if vul else 500

    if is_game:
        score += 500 if vul else 300
    else:
        score += 50

    if doubled == 'X':
        score += 50
    elif doubled == 'XX':
        score += 100

    return score


def _is_declarer_vul(declarer: str, vulnerability: str) -> bool:
    if vulnerability == 'both':
        return True
    if vulnerability == 'none':
        return False
    if vulnerability == 'ns':
        return declarer in ('N', 'S')
    if vulnerability == 'ew':
        return declarer in ('E', 'W')
    return False


def _doubled_undertrick_penalty(undertricks: int, vul: bool) -> int:
    if vul:
        return 200 + (undertricks - 1) * 300
    else:
        if undertricks == 1:
            return 100
        elif undertricks == 2:
            return 300
        elif undertricks == 3:
            return 500
        else:
            return 500 + (undertricks - 3) * 300


def _redoubled_undertrick_penalty(undertricks: int, vul: bool) -> int:
    return _doubled_undertrick_penalty(undertricks, vul) * 2
