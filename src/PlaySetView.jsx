import React, { useState, useEffect, useMemo } from 'react';
import { supabase as defaultSupabase } from './supabase.js';
import { buildTeamRows, buildPairRows, TravellerTable } from './AnalysisView.jsx';
import { PlayBoard } from 'games-display';

// BBO sometimes ends auctions with mb|ap| instead of three mb|p|.
function normalizeLinForIps(lin) {
  if (!lin) return null;
  return lin.replace(/mb\|ap\|/gi, 'mb|p|mb|p|mb|p|');
}

// ── Main PlaySetView ──────────────────────────────────────────────────────────

export default function PlaySetView({ supabase: sbProp, playSet, userId, onBack, DiscussionView }) {
  const supabase = sbProp || defaultSupabase;
  const direction = playSet.direction || null;
  const cardingNS = playSet.cardingNS || 'UDCA';
  const cardingEW = playSet.cardingEW || 'UDCA';

  const analysis = playSet.analysis;
  const [boards, setBoards] = useState([]);
  const [results, setResults] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [visitedIdxs, setVisitedIdxs] = useState(() => new Set([0]));
  const [playedResults, setPlayedResults] = useState({});

  const event = analysis?.bg_events;
  const tournament = event?.bg_tournaments;
  const filters = analysis?.filters || {};
  const isTeams = event?.type === 'teams';

  useEffect(() => {
    if (!analysis?.id) return;
    setLoading(true);

    let stageQuery;
    if (filters.stage_ids?.length) {
      stageQuery = supabase.from('bg_stages').select('id').in('id', filters.stage_ids);
    } else if (filters.stage_id) {
      stageQuery = supabase.from('bg_stages').select('id').eq('id', filters.stage_id);
    } else {
      stageQuery = supabase.from('bg_stages').select('id').eq('event_id', event.id);
    }

    const eventIds = filters.selections?.length
      ? [...new Set(filters.selections.map(s => s.event_id))]
      : [event.id];

    stageQuery.then(({ data: stages }) => {
      const stageIds = (stages || []).map(s => s.id);
      if (!stageIds.length) { setLoading(false); return; }

      const participantQuery = eventIds.length === 1
        ? supabase.from('bg_participants').select('id, number, name, roster').eq('event_id', eventIds[0]).order('number')
        : supabase.from('bg_participants').select('id, number, name, roster').in('event_id', eventIds).order('number');

      const fetchAllResults = async () => {
        const all = [];
        let from = 0;
        while (true) {
          const { data } = await supabase.from('bg_board_results').select('*')
            .in('stage_id', stageIds).order('id').range(from, from + 999);
          if (!data?.length) break;
          all.push(...data);
          if (data.length < 1000) break;
          from += 1000;
        }
        return { data: all };
      };

      Promise.all([
        supabase.from('bg_boards').select('*').in('stage_id', stageIds).order('board_number'),
        fetchAllResults(),
        participantQuery,
      ]).then(([bRes, rRes, pRes]) => {
        setBoards(bRes.data || []);
        setResults(rRes.data || []);
        setParticipants(pRes.data || []);
        setCurrentIdx(0);
        setVisitedIdxs(new Set([0]));
        setLoading(false);
      });
    });
  }, [analysis?.id]);

  const participantMap = useMemo(() => {
    const m = {};
    for (const p of participants) m[p.id] = p;
    return m;
  }, [participants]);

  const resultsByBoard = useMemo(() => {
    const m = {};
    for (const r of results) {
      if (!m[r.board_id]) m[r.board_id] = [];
      m[r.board_id].push(r);
    }
    return m;
  }, [results]);

  const displayRows = useMemo(() => {
    if (!boards.length || !results.length) return [];
    if (isTeams) return buildTeamRows(boards, results, filters, participantMap);
    return buildPairRows(boards, results, filters);
  }, [boards, results, filters, isTeams, participantMap]);

  const clampedIdx = Math.min(currentIdx, Math.max(0, displayRows.length - 1));
  const row = displayRows[clampedIdx];
  const goToBoard = (nextIdx) => {
    const target = Math.max(0, Math.min(displayRows.length - 1, nextIdx));
    setVisitedIdxs(current => {
      if (current.has(target)) return current;
      const next = new Set(current);
      next.add(target);
      return next;
    });
    setCurrentIdx(target);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-gray-400">Loading boards...</p>
      </div>
    );
  }

  const boardId = row?.board?.id;

  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="border-b border-gray-200 px-3 py-2 flex items-center gap-3">
        <button onClick={onBack} className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
          ← Back
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold truncate">{playSet.name}</h1>
          <p className="text-xs text-gray-500">
            {tournament?.name}
            {direction && <span className="ml-2 font-medium text-blue-600">Playing {direction}</span>}
          </p>
        </div>
        {displayRows.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => goToBoard(clampedIdx - 1)}
              disabled={clampedIdx === 0}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Prev
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              {clampedIdx + 1} / {displayRows.length}
            </span>
            <button
              onClick={() => goToBoard(clampedIdx + 1)}
              disabled={clampedIdx === displayRows.length - 1}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      <div className="px-2 py-2">
        {displayRows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No boards match the selected filters.</div>
        ) : row ? (
          displayRows.map((candidate, index) => visitedIdxs.has(index) ? (
            <div key={`${candidate.board?.id}-${candidate.result?.id || index}`} style={{ display: index === clampedIdx ? 'block' : 'none' }}>
              <PlayBoardRow
                row={candidate}
                isTeams={isTeams}
                scoring={event?.scoring}
                participantMap={participantMap}
                boardResults={resultsByBoard[candidate.board?.id] || []}
                ourParticipantId={filters.participant_id}
                direction={direction}
                cardingNS={cardingNS}
                cardingEW={cardingEW}
                playedResults={playedResults}
                onBoardComplete={(boardId, completion) => setPlayedResults(current => ({ ...current, [boardId]: completion }))}
              />
            </div>
          ) : null)
        ) : null}
      </div>
    </div>
  );
}

// ── PlayBoardRow ──────────────────────────────────────────────────────────────

function PlayBoardRow({ row, isTeams, scoring, participantMap, boardResults, ourParticipantId, direction, cardingNS, cardingEW, playedResults, onBoardComplete }) {
  const [popup, setPopup] = useState(null);

  if (!row.board) return null;

  const result = row.result;
  // Board number, result and traveller must share the same canonical board id.
  // Never relabel filtered rows by their position in the deal set.
  const boardNumber = row.board.board_number;

  // Seat names belong to the result record. Do not infer seats from roster order:
  // a participant roster is not guaranteed to be ordered N/S or E/W.
  const selectedSide = direction === 'E' || direction === 'W' ? 'EW' : 'NS';
  // "My" score follows the side actually being played on this board. The
  // deal-set participant filter may name the opposing team in this room.
  const selectedParticipantId = selectedSide === 'NS'
    ? result?.ns_participant_id
    : result?.ew_participant_id;
  const otherRoom = row.otherRoom;
  const otherRoomScore = otherRoom && selectedParticipantId
    ? (otherRoom.ns_participant_id === selectedParticipantId
      ? Number(otherRoom.score || 0)
      : otherRoom.ew_participant_id === selectedParticipantId
        ? -Number(otherRoom.score || 0)
        : null)
    : null;
  // Keep the mounted IPS deal stable when Results history changes. Recreating
  // this object on completion makes IpsPlayer treat it as a different deal and
  // clears the final Result / Score / IMPs display immediately.
  const boardResult = useMemo(() => result ? {
    ...result,
    lin: normalizeLinForIps(result.lin),
    player_n_name: result.player_n_name || undefined,
    player_s_name: result.player_s_name || undefined,
    player_e_name: result.player_e_name || undefined,
    player_w_name: result.player_w_name || undefined,
    completion_user_side: selectedSide,
    completion_other_score: otherRoomScore,
    completion_scoring: isTeams || String(scoring || '').toLowerCase().includes('imp') ? 'IMP' : null,
  } : null, [result, selectedSide, otherRoomScore, isTeams, scoring]);

  return (
    <div className="relative">
      <PlayBoard
        boardNumber={boardNumber}
        boardResult={boardResult}
        nsTeamName={isTeams ? participantMap?.[result?.ns_participant_id]?.name : undefined}
        ewTeamName={isTeams ? participantMap?.[result?.ew_participant_id]?.name : undefined}
        direction={direction}
        cardingNS={cardingNS}
        cardingEW={cardingEW}
        onComplete={(completion) => onBoardComplete?.(row.board.id, { boardNumber, ...completion })}
        onTraveller={() => setPopup(popup === 'traveller' ? null : 'traveller')}
        onResults={() => setPopup(popup === 'results' ? null : 'results')}
      />

      {/* Traveller popup */}
      {popup === 'traveller' && (
        <DraggablePlayPopup title={`Traveller — Board ${row.board.board_number}`} onClose={() => setPopup(null)}>
          <TravellerTable
            board={row.board}
            boardResults={boardResults}
            participantMap={participantMap}
            highlightParticipantId={ourParticipantId}
            isTeams={isTeams}
            scoring={scoring}
          />
        </DraggablePlayPopup>
      )}

      {popup === 'results' && (
        <DraggablePlayPopup title="My Results" onClose={() => setPopup(null)} width={360}>
          {Object.keys(playedResults || {}).length === 0 ? <div style={{ color: '#6b7280', fontSize: '0.8rem' }}>No completed boards yet.</div> : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}><thead><tr><th style={{ textAlign: 'left' }}>Board</th><th style={{ textAlign: 'left' }}>Result</th><th style={{ textAlign: 'right' }}>Score</th><th style={{ textAlign: 'right' }}>IMPs</th></tr></thead><tbody>
              {Object.values(playedResults).sort((a, b) => a.boardNumber - b.boardNumber).map((r, i) => <tr key={i} style={{ borderTop: '1px solid #e5e7eb' }}><td>{r.boardNumber}</td><td>{r.level}<span style={{ color: r.denomCode === 'H' || r.denomCode === 'D' ? '#c0241c' : '#111' }}>{r.denomCode === 'N' ? 'NT' : ({ S: '♠', H: '♥', D: '♦', C: '♣' }[r.denomCode] || r.denomCode)}</span>{r.doubled || ''} {r.declarer} {r.resultText}</td><td style={{ textAlign: 'right' }}>{r.score > 0 ? '+' : ''}{r.score}</td><td style={{ textAlign: 'right' }}>{r.imps == null ? '—' : `${r.imps > 0 ? '+' : ''}${r.imps}`}</td></tr>)}
            </tbody></table>
          )}
        </DraggablePlayPopup>
      )}

    </div>
  );
}

function DraggablePlayPopup({ title, onClose, width = 'max-content', children }) {
  const [position, setPosition] = useState({ x: 320, y: 72 });
  const dragOffset = React.useRef(null);

  const startDrag = (event) => {
    if (event.target.tagName === 'BUTTON') return;
    dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y };
    const move = (e) => setPosition({
      x: Math.max(8, Math.min(window.innerWidth - 180, e.clientX - dragOffset.current.x)),
      y: Math.max(8, Math.min(window.innerHeight - 60, e.clientY - dragOffset.current.y)),
    });
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    event.preventDefault();
  };

  return (
    <div style={{ position: 'fixed', left: position.x, top: position.y, width, maxWidth: 'calc(100vw - 24px)', zIndex: 50, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', maxHeight: '78vh', overflow: 'hidden' }}>
      <div onMouseDown={startDrag} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', cursor: 'move', userSelect: 'none' }}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{title}</span>
        <button onClick={onClose} style={{ cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1, background: 'none', border: 'none', color: '#6b7280' }}>&times;</button>
      </div>
      <div style={{ padding: 12, overflow: 'auto', maxHeight: 'calc(78vh - 42px)' }}>{children}</div>
    </div>
  );
}
