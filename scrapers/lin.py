"""Generate LIN (Bridge Base Online) format strings from deal data."""


# LIN dealer encoding: 1=S, 2=W, 3=N, 4=E
_DEALER_TO_LIN = {'S': '1', 'W': '2', 'N': '3', 'E': '4'}

# LIN vulnerability encoding
_VUL_TO_LIN = {'none': 'o', 'ns': 'n', 'ew': 'e', 'both': 'b'}

# LIN suit prefix in md| tag (hands encoded as S=spades, H=hearts, D=diamonds, C=clubs)
_SUIT_ORDER = ['S', 'H', 'D', 'C']

# LIN direction order for md| tag: starts from dealer, goes clockwise
_DIR_ORDER = ['S', 'W', 'N', 'E']

# Contract denomination for mb| tag
_DENOM_TO_LIN = {'C': 'C', 'D': 'D', 'H': 'H', 'S': 'S', 'NT': 'N'}

# Lead suit for pc| tag
_SUIT_TO_LIN = {'C': 'C', 'D': 'D', 'H': 'H', 'S': 'S'}

# Card rank normalization (T=10 in our schema, but LIN uses T)
_RANK_TO_LIN = {
    'A': 'A', 'K': 'K', 'Q': 'Q', 'J': 'J', 'T': 'T',
    '10': 'T', '9': '9', '8': '8', '7': '7', '6': '6',
    '5': '5', '4': '4', '3': '3', '2': '2',
}


def _encode_hand(spades, hearts, diamonds, clubs):
    """Encode one hand for the md| tag: SAKJ5HQT3DK84C962."""
    parts = []
    for prefix, holding in zip(_SUIT_ORDER, [spades, hearts, diamonds, clubs]):
        parts.append(prefix + (holding or ''))
    return ''.join(parts)


def generate_lin(*, dealer, vulnerability, hands, contract_level=None,
                 contract_denom=None, contract_x=None, declarer=None,
                 lead_suit=None, lead_rank=None, tricks=None,
                 player_n=None, player_e=None, player_s=None, player_w=None,
                 bidding=None, play=None, claim_tricks=None,
                 passed_out=False) -> str:
    """Generate a LIN string from available deal data.

    Args:
        dealer: 'N', 'E', 'S', 'W'
        vulnerability: 'none', 'ns', 'ew', 'both'
        hands: dict with keys 'n_spades', 'n_hearts', ..., 'w_clubs' (16 fields)
        contract_level: 1-7 or None
        contract_denom: 'C','D','H','S','NT' or None
        contract_x: None, 'X', 'XX'
        declarer: 'N','E','S','W' or None
        lead_suit: 'C','D','H','S' or None
        lead_rank: 'A'..'2' or None
        tricks: 0-13 or None
        player_n/e/s/w: player name strings or None
        bidding: list of dicts [{dir, bid, alert, explanation}] or None (lovebridge)
        play: list of trick dicts or None (lovebridge)
        claim_tricks: int or None
        passed_out: bool
    """
    parts = []

    # Player names — BBO pn| order is S,W,N,E
    names = [player_s or '', player_w or '', player_n or '', player_e or '']
    parts.append(f'pn|{",".join(names)}')

    # Hands — md| dealer number, then hands always in S,W,N,E order
    dealer_num = _DEALER_TO_LIN.get(dealer, '3')
    hand_strs = []
    for d in ['S', 'W', 'N', 'E']:
        dl = d.lower()
        hand_strs.append(_encode_hand(
            hands.get(f'{dl}_spades', ''),
            hands.get(f'{dl}_hearts', ''),
            hands.get(f'{dl}_diamonds', ''),
            hands.get(f'{dl}_clubs', ''),
        ))
    parts.append(f'md|{dealer_num}{",".join(hand_strs)}')

    # Vulnerability
    vul_code = _VUL_TO_LIN.get(vulnerability, 'o')
    parts.append(f'sv|{vul_code}')

    # Bidding
    if bidding:
        bids = []
        for b in bidding:
            bids.append(b.get('bid', 'P'))
        parts.append(f'mb|{"".join(bids)}')
    elif passed_out:
        parts.append('mb|pppp')
    elif contract_level and contract_denom and declarer:
        # No full bidding available — encode just the final contract as a minimal auction
        # This is lossy but captures what we know
        pass  # Skip mb| if we don't have the actual bidding

    # Opening lead
    if lead_suit and lead_rank:
        rank = _RANK_TO_LIN.get(lead_rank, lead_rank)
        parts.append(f'pc|{_SUIT_TO_LIN.get(lead_suit, lead_suit)}{rank}')

    # Play sequence (lovebridge)
    if play:
        for trick in play:
            if isinstance(trick, dict):
                cards = trick.get('cards', [])
                for card in cards:
                    s = _SUIT_TO_LIN.get(card.get('suit', ''), '')
                    r = _RANK_TO_LIN.get(card.get('rank', ''), '')
                    parts.append(f'pc|{s}{r}')

    # Claim
    if claim_tricks is not None:
        parts.append(f'mc|{claim_tricks}')

    return '|'.join(parts) + '|'
