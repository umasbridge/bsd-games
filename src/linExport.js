const DEALER_TO_LIN = { N: '3', E: '4', S: '1', W: '2' };
const VUL_TO_LIN = { none: 'o', ns: 'n', ew: 'e', both: 'b', NS: 'n', EW: 'e' };

function boardToLin(board, boardNumber) {
  const dealer = DEALER_TO_LIN[board.dealer] || '3';
  const vul = VUL_TO_LIN[board.vulnerability] || 'o';
  const hands = ['s', 'w', 'n', 'e'].map(d => {
    const sp = (board[`${d}_spades`] || '').replace(/10/g, 'T');
    const h = (board[`${d}_hearts`] || '').replace(/10/g, 'T');
    const dm = (board[`${d}_diamonds`] || '').replace(/10/g, 'T');
    const c = (board[`${d}_clubs`] || '').replace(/10/g, 'T');
    return `S${sp}H${h}D${dm}C${c}`;
  }).join(',');
  return `qx|o${boardNumber}|md|${dealer}${hands}|rh||ah|Board ${boardNumber}|sv|${vul}|pg||`;
}

export function openHandviewer(lin) {
  if (!lin) return;
  window.open(
    `https://www.bridgebase.com/tools/handviewer.html?bbo=y&lin=${encodeURIComponent(lin)}`,
    '_blank',
    'noopener',
  );
}

export async function downloadLin(supabase, analysis) {
  const filters = analysis.filters || {};
  const stageIds = filters.stage_ids || (filters.stage_id ? [filters.stage_id] : []);
  if (!stageIds.length) return;

  const { data: boards } = await supabase
    .from('bg_boards')
    .select('board_number, dealer, vulnerability, n_spades, n_hearts, n_diamonds, n_clubs, s_spades, s_hearts, s_diamonds, s_clubs, e_spades, e_hearts, e_diamonds, e_clubs, w_spades, w_hearts, w_diamonds, w_clubs')
    .in('stage_id', stageIds)
    .order('board_number');

  if (!boards?.length) return;

  const lines = boards.map(b => boardToLin(b, b.board_number));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(analysis.name || 'boards').replace(/[^a-zA-Z0-9_-]/g, '_')}.lin`;
  a.click();
  URL.revokeObjectURL(url);
}
