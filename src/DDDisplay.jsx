import { useState } from 'react';

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLORS = { S: '#000', H: '#c62828', D: '#c62828', C: '#2e7d32' };
const DENOMS = ['C', 'D', 'H', 'S', 'NT'];

export default function DDDisplay({ board }) {
  const nsBest = bestContracts(board, 'ns');
  const ewBest = bestContracts(board, 'ew');

  return (
    <div className="space-y-2 text-sm">
      {/* Best contracts */}
      {nsBest && (
        <div>
          <span className="font-medium text-gray-600">NS: </span>
          <span className="font-bold">{nsBest}</span>
        </div>
      )}
      {ewBest && (
        <div>
          <span className="font-medium text-gray-600">EW: </span>
          <span className="font-bold">{ewBest}</span>
        </div>
      )}
      {!nsBest && !ewBest && (
        <div className="text-gray-400 text-xs">No DD data</div>
      )}

      {/* DDS link - makeable contracts table */}
      {hasDDData(board) && <DDSPopup board={board} />}
    </div>
  );
}


function DDSPopup({ board }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs px-2 py-1 bg-teal-600 text-white rounded hover:bg-teal-700"
      >
        DDS
      </button>
      {open && (
        <div className="absolute z-10 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg p-3"
             style={{ minWidth: '220px' }}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-bold text-gray-600">Makeable Contracts</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
          </div>
          <MakeableTable board={board} />
        </div>
      )}
    </div>
  );
}


function MakeableTable({ board }) {
  const dirs = ['N', 'S', 'E', 'W'];

  return (
    <table className="text-xs" style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th className="px-2 py-1"></th>
          {DENOMS.map(d => (
            <th key={d} className="px-2 py-1 text-center" style={{ color: SUIT_COLORS[d] || '#333' }}>
              {d === 'NT' ? 'NT' : SUIT_SYMBOLS[d]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dirs.map(dir => (
          <tr key={dir}>
            <td className="px-2 py-0.5 font-bold">{dir}</td>
            {DENOMS.map(d => {
              const key = `dd_${dir.toLowerCase()}_${d.toLowerCase() === 'nt' ? 'nt' : d.toLowerCase()}`;
              const tricks = board[key];
              return (
                <td key={d} className="px-2 py-0.5 text-center">
                  {tricks != null ? tricks : '—'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}


function bestContracts(board, side) {
  if (!hasDDData(board)) return null;

  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  const vul = board.vulnerability;
  const isVul = side === 'ns'
    ? (vul === 'ns' || vul === 'both')
    : (vul === 'ew' || vul === 'both');

  let best = null;
  let bestScore = 0;

  for (const denom of DENOMS) {
    const denomKey = denom.toLowerCase() === 'nt' ? 'nt' : denom.toLowerCase();
    let maxTricks = 0;
    let bestDir = '';
    for (const dir of dirs) {
      const tricks = board[`dd_${dir}_${denomKey}`];
      if (tricks != null && tricks > maxTricks) {
        maxTricks = tricks;
        bestDir = dir.toUpperCase();
      }
    }
    if (maxTricks < 7) continue;

    const maxLevel = maxTricks - 6;
    let bestLevelScore = 0;
    let bestLevel = 1;
    for (let level = 1; level <= maxLevel; level++) {
      const sc = computeDDScore(denom, level, maxTricks, isVul);
      if (sc > bestLevelScore) {
        bestLevelScore = sc;
        bestLevel = level;
      }
    }
    if (bestLevelScore > bestScore) {
      bestScore = bestLevelScore;
      const sym = denom === 'NT' ? 'NT' : (SUIT_SYMBOLS[denom] || denom);
      best = `${bestLevel}${sym} by ${bestDir} = ${bestLevelScore}`;
    }
  }

  return best;
}


function computeDDScore(denom, level, tricks, vul) {
  const needed = level + 6;
  if (tricks < needed) return 0;
  const overtricks = tricks - needed;

  let trickScore, otVal;
  if (denom === 'C' || denom === 'D') {
    trickScore = level * 20;
    otVal = 20;
  } else if (denom === 'H' || denom === 'S') {
    trickScore = level * 30;
    otVal = 30;
  } else {
    trickScore = 40 + (level - 1) * 30;
    otVal = 30;
  }

  const isGame = trickScore >= 100;
  let score = trickScore + overtricks * otVal;

  if (level === 7) score += vul ? 1500 : 1000;
  else if (level === 6) score += vul ? 750 : 500;

  if (isGame) score += vul ? 500 : 300;
  else score += 50;

  return score;
}


function hasDDData(board) {
  for (const d of ['n', 's', 'e', 'w'])
    for (const k of ['c', 'd', 'h', 's', 'nt'])
      if (board[`dd_${d}_${k}`] != null) return true;
  return false;
}
