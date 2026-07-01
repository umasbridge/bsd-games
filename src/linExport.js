const DEALER_TO_LIN = { N: '3', E: '4', S: '1', W: '2' };
const VUL_TO_LIN = { none: 'o', ns: 'n', ew: 'e', both: 'b', NS: 'n', EW: 'e' };

function encodeHand(board, dir) {
  const d = dir.toLowerCase();
  const s = (board[`${d}_spades`] || '').replace(/10/g, 'T');
  const h = (board[`${d}_hearts`] || '').replace(/10/g, 'T');
  const dm = (board[`${d}_diamonds`] || '').replace(/10/g, 'T');
  const c = (board[`${d}_clubs`] || '').replace(/10/g, 'T');
  return `S${s}H${h}D${dm}C${c}`;
}

export function boardToLin(board, boardNumber) {
  const dealer = DEALER_TO_LIN[board.dealer] || '3';
  const vul = VUL_TO_LIN[board.vulnerability] || 'o';
  const hands = ['S', 'W', 'N', 'E'].map(d => encodeHand(board, d)).join(',');
  return `qx|o${boardNumber}|md|${dealer}${hands}|rh||ah|Board ${boardNumber}|sv|${vul}|pg||`;
}

export function exportLinFile(boards, fileName) {
  const lines = boards.map((b, i) => boardToLin(b, b.board_number ?? i + 1));
  if (!lines.length) return;
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
