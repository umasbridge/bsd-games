import { useState } from 'react';

const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLR = { S: '#000', H: '#c62828', D: '#c62828', C: '#2e7d32' };

export default function HandDiagram({ board, result, otherRoom, participantMap, ourParticipantId, onOtherRoom, onAnalysis, onTraveller, onNotes, notesLoading, isTeams, ddBest, optimalLines }) {
  const vul = board.vulnerability;

  const playerLabel = (dir) => {
    const name = result?.[`player_${dir.toLowerCase()}_name`] || '';
    if (name) return shortName(name);
    if (dir === 'N' || dir === 'S') {
      const p = participantMap?.[result?.ns_participant_id];
      if (p?.roster?.length >= 2) return shortName(dir === 'N' ? p.roster[0].name : p.roster[1].name);
    }
    if (dir === 'E' || dir === 'W') {
      const p = participantMap?.[result?.ew_participant_id];
      if (p?.roster?.length >= 2) return shortName(dir === 'E' ? p.roster[0].name : p.roster[1].name);
    }
    return null;
  };

  const contractStr = result ? fmtContract(result) : '';
  const hasBidding = result?.lin && parseBiddingFromLin(result.lin);
  const leadStr = result ? fmtLead(result) : '';
  const scoreStr = result ? (result.score > 0 ? `+${result.score}` : `${result.score}`) : '';
  const resultStr = result?.overtricks != null
    ? (result.overtricks === 0 ? '=' : result.overtricks > 0 ? `+${result.overtricks}` : `${result.overtricks}`)
    : '';

  // MP% for pairs
  const mpPct = result?.mp_ns != null && result?.mp_ew != null
    ? (() => { const total = (result.mp_ns || 0) + (result.mp_ew || 0); return total > 0 ? Math.round(((result.mp_ns || 0) / total) * 100) : null; })()
    : null;

  const nsBest = bestContracts(board, 'ns');
  const ewBest = bestContracts(board, 'ew');

  // IMP calculation: our score in this room + our score in other room
  let boardImps = null;
  if (otherRoom && result) {
    let ourScoreHere, ourScoreThere;
    if (ourParticipantId) {
      ourScoreHere = result.ns_participant_id === ourParticipantId ? (result.score || 0) : -(result.score || 0);
      ourScoreThere = otherRoom.ns_participant_id === ourParticipantId ? (otherRoom.score || 0) : -(otherRoom.score || 0);
    } else {
      ourScoreHere = result.score || 0;
      // In team matches NS/EW swap between rooms
      const swapped = result.ns_participant_id === otherRoom.ew_participant_id;
      ourScoreThere = swapped ? -(otherRoom.score || 0) : (otherRoom.score || 0);
    }
    boardImps = scoreToImps(ourScoreHere + ourScoreThere);
  }

  const resultBar = result && (
    <div style={{ fontSize: '0.85rem' }}>
      {!hasBidding && !result.passed_out && (
        <span style={{ fontWeight: 700 }}>
          {fmtContractColored(result)} <span style={{ color: '#6b7280', fontWeight: 400 }}>by {result.declarer}</span>
          <span style={{ color: '#9ca3af', margin: '0 4px' }}>·</span>
        </span>
      )}
      <span style={{ fontWeight: 700 }}>{resultStr}</span>
      <span style={{ fontWeight: 700 }}> ({scoreStr})</span>
      {mpPct != null && (
        <span style={{ marginLeft: 6, fontWeight: 700, color: mpPct >= 60 ? '#15803d' : mpPct <= 40 ? '#dc2626' : '#6b7280' }}>
          {mpPct}%
        </span>
      )}
      {boardImps != null && (
        <span style={{ marginLeft: 6, fontWeight: 700, color: boardImps > 0 ? '#15803d' : boardImps < 0 ? '#dc2626' : '#6b7280' }}>
          {boardImps > 0 ? '+' : ''}{boardImps} IMPs
        </span>
      )}
      <span style={{ color: '#6b7280', marginLeft: 8 }}>
        Lead: {leadStr}
      </span>
    </div>
  );

  const optimalBlock = optimalLines && optimalLines.length > 0 && (
    <div style={{ fontSize: '0.8rem', marginTop: 4 }}>
      {optimalLines.map((line, i) => {
        const c = line.contract;
        const otStr = c.ot > 0 ? `+${c.ot}` : c.ot < 0 ? `↓${Math.abs(c.ot)}` : '=';
        const sideScore = line.label === 'NS' ? line.nsScore : -line.nsScore;
        const scoreStr = sideScore > 0 ? `+${sideScore}` : `${sideScore}`;
        const mp = line.label === 'NS' ? line.nsMp : line.ewMp;
        const sideImps = line.imps != null ? (line.label === 'NS' ? line.imps : -line.imps) : null;
        return (
          <div key={i} style={{ marginTop: i > 0 ? 2 : 0 }}>
            <span style={{ color: '#92400e', fontWeight: 700, fontSize: '0.75rem' }}>Best for {line.label}: </span>
            <span style={{ fontWeight: 600 }}>
              {c.level}<span style={{ color: SUIT_CLR[c.denom] || '#333' }}>{SUIT_SYM[c.denom] || c.denom}</span>{c.x}
            </span>
            <span style={{ color: '#6b7280' }}> by {c.dir} {otStr} ({scoreStr})</span>
            {sideImps != null && <span style={{ fontWeight: 600, color: sideImps > 0 ? '#15803d' : '#6b7280', marginLeft: 4 }}>{sideImps > 0 ? '+' : ''}{sideImps} IMPs</span>}
            {sideImps == null && mp != null && <span style={{ fontWeight: 600, color: '#15803d', marginLeft: 4 }}>{Math.round(mp)}%</span>}
          </div>
        );
      })}
    </div>
  );

  const buttonsBlock = (
    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
      {hasDDData(board) && <DDSPopup board={board} />}
      {onTraveller && (
        <button onClick={onTraveller}
          style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Traveller
        </button>
      )}
      {onNotes && (
        <button onClick={onNotes} disabled={notesLoading}
          style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: notesLoading ? 0.5 : 1 }}>
          {notesLoading ? '...' : 'My Notes'}
        </button>
      )}
    </div>
  );

  const otherRoomBlock = isTeams && otherRoom && (
    <div
      onClick={onOtherRoom}
      style={{
        border: '1px solid #d1d5db',
        borderRadius: 6, padding: '6px 10px', marginTop: 6,
        cursor: onOtherRoom ? 'pointer' : 'default',
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#1e40af' }}>OTHER ROOM</span>
        {onOtherRoom && <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#2563eb' }}>→</span>}
      </div>
      <div style={{ marginTop: 2 }}>
        {fmtContract(otherRoom)} by {otherRoom.declarer}
        {' '}{otherRoom.overtricks != null ? (otherRoom.overtricks === 0 ? '= ' : otherRoom.overtricks > 0 ? `+${otherRoom.overtricks} ` : `${otherRoom.overtricks} `) : ' '}
        ({otherRoom.score > 0 ? `+${otherRoom.score}` : `${otherRoom.score}`})
      </div>
    </div>
  );

  return (
    <div>
      {/* Mobile: compact layout — result bar, deal, analysis, buttons */}
      <div className="md:hidden">
        {resultBar}
        <div style={{ marginTop: 4 }}>
          <DealDiagram board={board} playerLabel={playerLabel} vul={vul} />
        </div>
        {optimalBlock}
        {otherRoomBlock}
        {buttonsBlock}
      </div>

      {/* Desktop: side-by-side — left panel | deal diagram */}
      <div className="hidden md:flex md:gap-5">
        <div style={{ fontSize: '0.85rem', flex: '0 0 320px' }}>
          {result?.lin && <BiddingTable lin={result.lin} dealer={board.dealer} />}
          {result && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', marginTop: 6 }}>
              {!hasBidding && !result.passed_out && (
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  {fmtContractColored(result)} <span style={{ color: '#6b7280', fontWeight: 400 }}>by {result.declarer}</span>
                </div>
              )}
              <div>
                <span style={{ color: '#6b7280' }}>Result: </span>
                <span style={{ fontWeight: 700 }}>{resultStr}</span>
                <span style={{ fontWeight: 700 }}> ({scoreStr})</span>
                {mpPct != null && (
                  <span style={{ marginLeft: 6, fontWeight: 700, color: mpPct >= 60 ? '#15803d' : mpPct <= 40 ? '#dc2626' : '#6b7280' }}>
                    {mpPct}%
                  </span>
                )}
                {boardImps != null && (
                  <span style={{ marginLeft: 6, fontWeight: 700, color: boardImps > 0 ? '#15803d' : boardImps < 0 ? '#dc2626' : '#6b7280' }}>
                    {boardImps > 0 ? '+' : ''}{boardImps} IMPs
                  </span>
                )}
              </div>
              <div style={{ color: '#6b7280', marginTop: 2 }}>
                Lead: {leadStr}
              </div>
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            {optimalBlock}
          </div>
          {otherRoomBlock}
          {buttonsBlock}
        </div>
        <div style={{ flex: 1 }}>
          <DealDiagram board={board} playerLabel={playerLabel} vul={vul} />
        </div>
      </div>
    </div>
  );
}


function DealDiagram({ board, playerLabel, vul }) {
  return (
    <div style={{
      display: 'inline-grid',
      gridTemplateColumns: 'auto auto auto',
      gridTemplateRows: 'auto auto auto',
      columnGap: 12,
      rowGap: 4,
      alignItems: 'center',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: '0.9rem',
      color: '#000',
    }}>
      <div style={{ gridColumn: 2, gridRow: 1, justifySelf: 'start' }}>
        <PlayerLabel name={playerLabel('N')} dir="N" isDealer={board.dealer === 'N'} />
        <HandBlock board={board} dir="n" />
      </div>
      <div style={{ gridColumn: 1, gridRow: 2, justifySelf: 'end' }}>
        <PlayerLabel name={playerLabel('W')} dir="W" isDealer={board.dealer === 'W'} />
        <HandBlock board={board} dir="w" />
      </div>
      <div style={{ gridColumn: 2, gridRow: 2, justifySelf: 'start' }}>
        <Compass vul={vul} dealer={board.dealer} />
      </div>
      <div style={{ gridColumn: 3, gridRow: 2, justifySelf: 'start' }}>
        <PlayerLabel name={playerLabel('E')} dir="E" isDealer={board.dealer === 'E'} />
        <HandBlock board={board} dir="e" />
      </div>
      <div style={{ gridColumn: 2, gridRow: 3, justifySelf: 'start' }}>
        <PlayerLabel name={playerLabel('S')} dir="S" isDealer={board.dealer === 'S'} />
        <HandBlock board={board} dir="s" />
      </div>
    </div>
  );
}


function PlayerLabel({ name, dir, isDealer }) {
  if (!name) return null;
  return (
    <div style={{
      fontSize: '0.8rem',
      color: isDealer ? '#fff' : '#555',
      fontWeight: 600,
      borderBottom: isDealer ? 'none' : '2px solid #333',
      background: isDealer ? '#2563eb' : 'transparent',
      padding: isDealer ? '1px 6px' : '0 0 1px 0',
      borderRadius: isDealer ? 3 : 0,
      marginBottom: 2,
      display: 'inline-block',
    }}>
      {name}
    </div>
  );
}


function HandBlock({ board, dir, align }) {
  const suits = [
    { key: 'spades', sym: '♠', cls: '#000' },
    { key: 'hearts', sym: '♥', cls: '#c62828' },
    { key: 'diamonds', sym: '♦', cls: '#c62828' },
    { key: 'clubs', sym: '♣', cls: '#2e7d32' },
  ];
  return (
    <div style={{ whiteSpace: 'nowrap', textAlign: align || 'left', lineHeight: 1.45 }}>
      {suits.map(s => {
        const cards = board[`${dir}_${s.key}`] || '—';
        return (
          <div key={s.key}>
            <span style={{ color: s.cls, fontWeight: 'bold' }}>{s.sym}</span>
            {' '}{cards}
          </div>
        );
      })}
    </div>
  );
}


function Compass({ vul, dealer }) {
  const nsVul = vul === 'ns' || vul === 'both';
  const ewVul = vul === 'ew' || vul === 'both';

  const ball = (dir, cx, cy) => {
    const isVul = (nsVul && (dir === 'N' || dir === 'S')) || (ewVul && (dir === 'E' || dir === 'W'));
    const bg = isVul ? '#c62828' : '#2e7d32';
    const decor = dir === dealer ? ' text-decoration="underline"' : '';
    return `<circle cx="${cx}" cy="${cy}" r="13" fill="${bg}"/>` +
           `<text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="white" font-size="13" font-weight="bold"${decor}>${dir}</text>`;
  };

  const svg = `<svg width="72" height="72" viewBox="0 0 72 72">
    ${ball('N', 36, 13)}
    ${ball('W', 13, 36)}
    ${ball('E', 59, 36)}
    ${ball('S', 36, 59)}
  </svg>`;

  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}


// ── Bidding table ────────────────────────────────────────────────

function BiddingTable({ lin, dealer }) {
  const bids = parseBiddingFromLin(lin);
  if (!bids || bids.length === 0) return null;

  const dirs = ['W', 'N', 'E', 'S'];
  const dealerMatch = lin.match(/md\|(\d)/);
  const linDealer = dealerMatch ? parseInt(dealerMatch[1]) : 3;
  const linDirOrder = ['S', 'W', 'N', 'E'];
  const startDir = linDirOrder[linDealer - 1] || dealer || 'N';
  const startIdx = dirs.indexOf(startDir);

  const rows = [];
  let currentRow = new Array(4).fill(null);
  for (let i = 0; i < startIdx; i++) currentRow[i] = '';
  let col = startIdx;

  for (const bid of bids) {
    currentRow[col] = bid;
    col++;
    if (col >= 4) { rows.push(currentRow); currentRow = new Array(4).fill(null); col = 0; }
  }
  if (currentRow.some(c => c !== null)) rows.push(currentRow);

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #d1d5db' }}>
            {dirs.map(d => (
              <th key={d} style={{ padding: '2px 8px', textAlign: 'center', fontWeight: 700, color: '#374151' }}>
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '2px 8px', textAlign: 'center' }}>
                  {cell === null ? '' : formatBidCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseBiddingFromLin(lin) {
  if (!lin) return null;
  const mbMatch = lin.match(/mb\|([^|]*)\|/);
  if (!mbMatch || !mbMatch[1]) return null;
  const bids = [];
  const regex = /([1-7][CDHSN]T?|P|X{1,2})/gi;
  let m;
  while ((m = regex.exec(mbMatch[1])) !== null) bids.push(m[1].toUpperCase());
  return bids.length > 0 ? bids : null;
}

function formatBidCell(bid) {
  if (!bid) return '';
  if (bid === 'P') return <span style={{ color: '#15803d' }}>Pass</span>;
  if (bid === 'X') return <span style={{ color: '#dc2626', fontWeight: 700 }}>X</span>;
  if (bid === 'XX') return <span style={{ color: '#2563eb', fontWeight: 700 }}>XX</span>;
  const level = bid[0];
  const ds = bid.substring(1);
  const map = { C: ['♣','#2e7d32'], D: ['♦','#c62828'], H: ['♥','#c62828'], S: ['♠','#000'], NT: ['NT','#333'], N: ['NT','#333'] };
  const [sym, col] = map[ds] || [ds, '#333'];
  return <span style={{ fontSize: '1.05rem' }}>{level}<span style={{ color: col, fontWeight: 700 }}>{sym}</span></span>;
}


// ── DDS popup ────────────────────────────────────────────────────

function DDSPopup({ board }) {
  const [open, setOpen] = useState(false);
  const DENOMS = ['C', 'D', 'H', 'S', 'NT'];
  return (
    <div style={{ position: 'relative', display: 'inline-block', marginTop: 4 }}>
      <button onClick={() => setOpen(!open)}
        style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#0d9488', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
        DDS
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 10, marginTop: 4, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 12, minWidth: 220 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#4b5563' }}>Makeable Contracts</span>
            <button onClick={() => setOpen(false)} style={{ color: '#9ca3af', cursor: 'pointer', border: 'none', background: 'none', fontSize: '0.75rem' }}>✕</button>
          </div>
          <table style={{ fontSize: '0.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ padding: '2px 8px' }}></th>
                {DENOMS.map(d => <th key={d} style={{ padding: '2px 8px', textAlign: 'center', color: SUIT_CLR[d] || '#333' }}>{d === 'NT' ? 'NT' : SUIT_SYM[d]}</th>)}
              </tr>
            </thead>
            <tbody>
              {['N','S','E','W'].map(dir => (
                <tr key={dir}>
                  <td style={{ padding: '1px 8px', fontWeight: 700 }}>{dir}</td>
                  {DENOMS.map(d => {
                    const key = `dd_${dir.toLowerCase()}_${d.toLowerCase() === 'nt' ? 'nt' : d.toLowerCase()}`;
                    return <td key={d} style={{ padding: '1px 8px', textAlign: 'center' }}>{board[key] != null ? board[key] : '—'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ── DD best contracts ────────────────────────────────────────────

function bestContracts(board, side) {
  if (!hasDDData(board)) return null;
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  const vul = board.vulnerability;
  const isVulSide = side === 'ns' ? (vul === 'ns' || vul === 'both') : (vul === 'ew' || vul === 'both');
  let best = null, bestScore = 0;
  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    const isMinor = denom === 'C' || denom === 'D';
    let maxT = 0, bestD = '';
    for (const dir of dirs) { const t = board[`dd_${dir}_${dk}`]; if (t != null && t > maxT) { maxT = t; bestD = dir.toUpperCase(); } }
    if (maxT < 7) continue;
    const maxL = maxT - 6;
    let bls = 0, bl = 1;
    for (let l = 1; l <= maxL; l++) { const sc = ddScore(l, denom, maxT, isVulSide, isMinor); if (sc > bls) { bls = sc; bl = l; } }
    if (bls > bestScore) { bestScore = bls; const sym = denom === 'NT' ? 'NT' : (SUIT_SYM[denom] || denom); best = `${bl}${sym} by ${bestD} = ${bls}`; }
  }
  return best;
}

function ddScore(level, denom, tricks, vul, isMinor) {
  const needed = level + 6; if (tricks < needed) return 0;
  const ot = tricks - needed;
  let ts, otv;
  if (isMinor) { ts = level * 20; otv = 20; }
  else if (denom === 'NT') { ts = 40 + (level - 1) * 30; otv = 30; }
  else { ts = level * 30; otv = 30; }
  const isGame = ts >= 100;
  let score = ts + ot * otv;
  if (level === 7) score += vul ? 1500 : 1000;
  else if (level === 6) score += vul ? 750 : 500;
  if (isGame) score += vul ? 500 : 300; else score += 50;
  return score;
}

function hasDDData(board) { return board.dd_n_nt != null || board.dd_s_nt != null; }

const IMP_TABLE = [
  [0,10,0],[20,40,1],[50,80,2],[90,120,3],[130,160,4],[170,210,5],
  [220,260,6],[270,310,7],[320,360,8],[370,420,9],[430,490,10],
  [500,590,11],[600,740,12],[750,890,13],[900,1090,14],[1100,1290,15],
  [1300,1490,16],[1500,1740,17],[1750,1990,18],[2000,2240,19],
  [2250,2490,20],[2500,2990,21],[3000,3490,22],[3500,3990,23],[4000,Infinity,24],
];

function scoreToImps(swing) {
  const abs = Math.abs(swing);
  const sign = swing >= 0 ? 1 : -1;
  for (const [lo, hi, imp] of IMP_TABLE) {
    if (abs >= lo && abs <= hi) return sign * imp;
  }
  return sign * 24;
}


// ── Helpers ──────────────────────────────────────────────────────

function fmtContract(r) {
  if (r.passed_out) return 'Pass';
  const x = r.contract_x || '';
  const sym = SUIT_SYM[r.contract_denom] || r.contract_denom || '';
  return `${r.contract_level}${sym}${x}`;
}

function fmtContractColored(r) {
  if (r.passed_out) return 'Pass';
  const x = r.contract_x || '';
  const d = r.contract_denom;
  const sym = SUIT_SYM[d] || d || '';
  const col = SUIT_CLR[d] || '#333';
  return <>{r.contract_level}<span style={{ color: col }}>{sym}</span>{x}</>;
}

function fmtLead(r) {
  if (!r.lead_suit) return '';
  return `${SUIT_SYM[r.lead_suit] || r.lead_suit}${r.lead_rank || ''}`;
}

function vulLabel(v) {
  switch (v) { case 'none': return 'None vul'; case 'ns': return 'NS vul'; case 'ew': return 'EW vul'; case 'both': return 'Both vul'; default: return v; }
}

function shortName(name) {
  if (!name) return '';
  return name.length <= 14 ? name : name.substring(0, 13) + '…';
}

function truncate(s, n) { if (!s) return ''; return s.length > n ? s.substring(0, n) + '…' : s; }

function otherTeamName(result, otherRoom, ourParticipantId, participantMap) {
  const ids = [result?.ns_participant_id, result?.ew_participant_id, otherRoom?.ns_participant_id, otherRoom?.ew_participant_id];
  const otherId = ids.find(id => id && id !== ourParticipantId);
  return otherId ? participantMap?.[otherId]?.name || 'EW' : 'EW';
}
