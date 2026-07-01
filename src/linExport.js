export function formatForBbo(storedLin, boardNumber) {
  const md = (storedLin.match(/md\|[^|]+\|/) || [''])[0];
  const sv = (storedLin.match(/sv\|[^|]+\|/) || [''])[0];
  const tags = [];
  const mbMatches = [...storedLin.matchAll(/mb\|[^|]*\|/g)];
  if (mbMatches.length) tags.push(mbMatches.map(m => m[0]).join(''));
  const pcMatches = [...storedLin.matchAll(/pc\|[^|]*\|/g)];
  if (pcMatches.length) tags.push(pcMatches.map(m => m[0]).join(''));
  const mc = (storedLin.match(/mc\|[^|]+\|/) || [''])[0];
  if (mc) tags.push(mc);
  return `qx|o${boardNumber}|${md}rh||ah|Board ${boardNumber}|${sv}${tags.join('')}pg||`;
}

export function exportLinFile(rows, fileName) {
  const lines = [];
  rows.forEach((row, i) => {
    if (!row.result?.lin) return;
    const bn = row.board?.board_number ?? i + 1;
    lines.push(formatForBbo(row.result.lin, bn));
    if (row.otherRoom?.lin) {
      lines.push(formatForBbo(row.otherRoom.lin, bn).replace('qx|o', 'qx|c'));
    }
  });
  if (!lines.length) return;
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
