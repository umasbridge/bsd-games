import React, { useState, useEffect, useMemo } from 'react';
import { supabase as defaultSupabase } from './supabase.js';
import HandDiagram, { BiddingTable } from './HandDiagram.jsx';
import { openHandviewer } from './linExport.js';

export default function AnalysisView({ supabase: sbProp, analysis, userId, onBack, onDisplayRows, DiscussionView }) {
  const supabase = sbProp || defaultSupabase;
  const [boards, setBoards] = useState([]);
  const [results, setResults] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);

  const event = analysis.bg_events;
  const tournament = event?.bg_tournaments;
  const filters = analysis.filters || {};
  const isTeams = event?.type === 'teams';

  useEffect(() => {
    if (!event?.id) return;

    // Resolve stage IDs: new multi-stage → old single stage → all event stages
    let stageQuery;
    if (filters.stage_ids?.length) {
      stageQuery = supabase.from('bg_stages').select('id').in('id', filters.stage_ids);
    } else if (filters.stage_id) {
      stageQuery = supabase.from('bg_stages').select('id').eq('id', filters.stage_id);
    } else {
      stageQuery = supabase.from('bg_stages').select('id').eq('event_id', event.id);
    }

    // Resolve event IDs for participant loading
    const eventIds = filters.selections?.length
      ? [...new Set(filters.selections.map(s => s.event_id))]
      : [event.id];

    stageQuery.then(({ data: stages }) => {
        const stageIds = (stages || []).map(s => s.id);
        if (!stageIds.length) { setLoading(false); return; }

        const participantQuery = eventIds.length === 1
          ? supabase.from('bg_participants').select('id, number, name, roster').eq('event_id', eventIds[0]).order('number')
          : supabase.from('bg_participants').select('id, number, name, roster').in('event_id', eventIds).order('number');

        // Fetch all results, paginating to avoid Supabase 1000-row limit
        const fetchAllResults = async () => {
          const all = [];
          const pageSize = 1000;
          let from = 0;
          while (true) {
            const { data } = await supabase
              .from('bg_board_results')
              .select('*')
              .in('stage_id', stageIds)
              .order('id')
              .range(from, from + pageSize - 1);
            if (!data || data.length === 0) break;
            all.push(...data);
            if (data.length < pageSize) break;
            from += pageSize;
          }
          return { data: all };
        };

        return Promise.all([
          supabase
            .from('bg_boards')
            .select('*')
            .in('stage_id', stageIds)
            .order('board_number'),
          fetchAllResults(),
          participantQuery,
        ]);
      })
      .then((results) => {
        if (!results) return;
        const [bRes, rRes, pRes] = results;
        setBoards(bRes.data || []);
        setResults(rRes.data || []);
        setParticipants(pRes.data || []);
        setLoading(false);
      });
  }, [event?.id]);

  const participantMap = useMemo(() => {
    const m = {};
    for (const p of participants) m[p.id] = p;
    return m;
  }, [participants]);

  const boardMap = useMemo(() => {
    const m = {};
    for (const b of boards) m[b.id] = b;
    return m;
  }, [boards]);

  // Group all results by board_id for traveller display
  const resultsByBoard = useMemo(() => {
    const m = {};
    for (const r of results) {
      if (!m[r.board_id]) m[r.board_id] = [];
      m[r.board_id].push(r);
    }
    return m;
  }, [results]);

  // Build display rows: for teams, pair open+closed room; for pairs, individual results
  const displayRows = useMemo(() => {
    if (!boards.length || !results.length) return [];

    if (isTeams) {
      return buildTeamRows(boards, results, filters, participantMap);
    } else {
      return buildPairRows(boards, results, filters);
    }
  }, [boards, results, filters, isTeams, participantMap]);

  useEffect(() => {
    if (onDisplayRows && displayRows.length > 0) onDisplayRows(displayRows);
  }, [displayRows]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-gray-400">Loading boards...</p>
      </div>
    );
  }


  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="border-b border-gray-200 px-3 py-2 flex items-center gap-2">
        <button onClick={onBack} className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
          &larr; Back
        </button>
        <div>
          <h1 className="text-sm font-bold">{analysis.name}</h1>
          <p className="text-xs text-gray-500">
            {filters.stage_ids?.length > 1
              ? `${filters.stage_ids.length} stages · ${displayRows.length} boards`
              : `${tournament?.name} · ${displayRows.length} boards`
            }
          </p>
        </div>
      </div>

      {/* Board rows */}
      <div className="px-2 py-2">
        {displayRows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No boards match the selected filters.
          </div>
        ) : (
          displayRows.map((row, i) => (
            <BoardRow
              key={i}
              row={row}
              isTeams={isTeams}
              participantMap={participantMap}
              boardResults={resultsByBoard[row.board?.id] || []}
              highlightParticipantId={filters.participant_id}
              ourParticipantId={filters.participant_id}
              supabase={supabase}
              userId={userId}
              analysisId={analysis.id}
              analysisName={analysis.name}
              sharedWith={filters.shared_with}
              DiscussionView={DiscussionView}
            />
          ))
        )}
      </div>
    </div>
  );
}


export function buildTeamRows(boards, results, filters, participantMap) {
  const boardMap = {};
  for (const b of boards) boardMap[b.id] = b;

  // Sort results deterministically so grouping order is consistent across calls
  const sorted = [...results].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  // Group results by board_id + match_id → open/closed pair
  const groups = {};
  for (const r of sorted) {
    if (!r.match_id) continue;
    const key = `${r.board_id}__${r.match_id}__${r.round || ''}`;
    if (!groups[key]) groups[key] = {};
    if (r.room === 'open') groups[key].open = r;
    else if (r.room === 'closed') groups[key].closed = r;
  }

  let pairs = Object.values(groups).filter(g => g.open && g.closed);

  // Filter by team
  const pid = filters.participant_id;
  if (pid) {
    pairs = pairs.filter(({ open, closed }) =>
      open.ns_participant_id === pid || open.ew_participant_id === pid ||
      closed.ns_participant_id === pid || closed.ew_participant_id === pid
    );
  }

  const activeFilters = filters.active_filters || [];

  // Compute our IMP total per board from score swing (matches HandDiagram display)
  const withImps = pairs.map(pair => {
    let ourImps = null;
    if (pid) {
      const openOurs = pair.open.ns_participant_id === pid;
      const openScore = openOurs ? (pair.open.score || 0) : -(pair.open.score || 0);
      const closedOurs = pair.closed.ns_participant_id === pid;
      const closedScore = closedOurs ? (pair.closed.score || 0) : -(pair.closed.score || 0);
      ourImps = scoreToImps(openScore + closedScore);
    }
    return { ...pair, ourImps };
  });

  let filtered = withImps;

  // Apply active filters (AND logic: board must match ALL checked filters)
  if (activeFilters.length > 0) {
    filtered = withImps.filter(({ open, closed, ourImps }) => {
      const board = boardMap[open.board_id];

      for (const f of activeFilters) {
        if (f === 'diff_contract') {
          if (open.contract_level === closed.contract_level &&
              open.contract_denom === closed.contract_denom) return false;
        }
        if (f === 'same_contract_down') {
          if (!(open.contract_level === closed.contract_level &&
              open.contract_denom === closed.contract_denom &&
              ((open.overtricks >= 0 && closed.overtricks < 0) ||
               (open.overtricks < 0 && closed.overtricks >= 0)))) return false;
        }
        if (f === 'game_both_tables') {
          if (!((open.contract_level || 0) >= 4 && (closed.contract_level || 0) >= 4)) return false;
        }
        if (f === 'defender_bid_high') {
          if (!(hasDefenderBidHigh(open) || hasDefenderBidHigh(closed))) return false;
        }
        if (f === 'imp_loss') {
          const threshold = filters.imp_threshold || 5;
          // If team selected, use total IMPs; otherwise use per-room IMPs
          if (ourImps !== null) {
            if (Math.abs(ourImps) <= threshold) return false;
          } else {
            const maxImp = Math.max(Math.abs(open.imps_ns || 0), Math.abs(closed.imps_ns || 0));
            if (maxImp <= threshold) return false;
          }
        }
        if (f === 'suboptimal' && board && pid) {
          if (!isSuboptimalTeam(open, closed, board, pid)) return false;
        }
      }
      return true;
    });
  }

  // Sort deterministically: board number, then round, then board_id as tiebreaker
  filtered.sort((a, b) => {
    const ba = boardMap[a.open.board_id]?.board_number || 0;
    const bb = boardMap[b.open.board_id]?.board_number || 0;
    if (ba !== bb) return ba - bb;
    const ra = a.open.round || 0;
    const rb = b.open.round || 0;
    if (ra !== rb) return ra - rb;
    if (a.open.board_id < b.open.board_id) return -1;
    if (a.open.board_id > b.open.board_id) return 1;
    if (a.open.match_id < b.open.match_id) return -1;
    if (a.open.match_id > b.open.match_id) return 1;
    return 0;
  });

  let rows = filtered.map(({ open, closed, ourImps }) => {
    let ours = open;
    let theirs = closed;
    if (pid) {
      const ourInOpen = open.ns_participant_id === pid || open.ew_participant_id === pid;
      if (!ourInOpen) {
        ours = closed;
        theirs = open;
      }
    }
    return {
      board: boardMap[open.board_id],
      result: ours,
      otherRoom: theirs,
      ourImps,
    };
  });

  // When no team selected, deduplicate by board — show first match, rest in traveller
  if (!pid) {
    const seen = {};
    rows = rows.filter(r => {
      const bid = r.board?.id;
      if (!bid) return true;
      if (seen[bid]) return false;
      seen[bid] = true;
      return true;
    });
  }

  for (let i = 0; i < rows.length; i++) {
    rows[i].displayBoardNumber = i + 1;
  }

  return rows;
}


export function buildPairRows(boards, results, filters) {
  const boardMap = {};
  for (const b of boards) boardMap[b.id] = b;

  let filtered = [...results].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  const pid = filters.participant_id;
  if (pid) {
    filtered = filtered.filter(r =>
      r.ns_participant_id === pid || r.ew_participant_id === pid
    );
  }

  const activeFilters = filters.active_filters || [];

  if (activeFilters.length > 0) {
    filtered = filtered.filter(r => {
      const board = boardMap[r.board_id];

      for (const f of activeFilters) {
        if (f === 'low_pct') {
          const threshold = filters.pct_threshold || 40;
          const maxMp = (r.mp_ns || 0) + (r.mp_ew || 0);
          const pct = maxMp > 0 ? ((r.mp_ns || 0) / maxMp) * 100 : 50;
          const ourPct = pid && r.ew_participant_id === pid
            ? (maxMp > 0 ? ((r.mp_ew || 0) / maxMp) * 100 : 50)
            : pct;
          if (ourPct >= threshold) return false;
        }
        if (f === 'suboptimal' && board && pid) {
          if (!isSuboptimalPair(r, board, pid)) return false;
        }
      }
      return true;
    });
  }

  // Build stage label map for multi-session display
  const stageIds = filters.stage_ids || [];
  const multiSession = stageIds.length > 1;
  const stageIndex = {};
  const stageLabel = {};
  if (multiSession) {
    stageIds.forEach((sid, i) => { stageIndex[sid] = i + 1; });
    const sels = filters.selections || [];
    const uniqueTournaments = new Set(sels.map(s => s.tournament_id));
    const uniqueEvents = new Set(sels.map(s => s.event_id));
    for (const sel of sels) {
      let label = sel.stage_name || `S${stageIndex[sel.stage_id] || ''}`;
      if (uniqueEvents.size > 1) {
        label = `${sel.event_name} - ${label}`;
      }
      if (uniqueTournaments.size > 1) {
        const dateMatch = sel.tournament_name?.match(/(\d{4}-\d{2}-\d{2})/);
        const dateShort = dateMatch ? dateMatch[1].slice(5) : '';
        label = dateShort ? `${dateShort} ${label}` : label;
      }
      stageLabel[sel.stage_id] = label;
    }
  }

  filtered.sort((a, b) => {
    const sa = stageIndex[boardMap[a.board_id]?.stage_id] || 0;
    const sb = stageIndex[boardMap[b.board_id]?.stage_id] || 0;
    if (sa !== sb) return sa - sb;
    const ra = a.round || 0;
    const rb = b.round || 0;
    if (ra !== rb) return ra - rb;
    const ba = boardMap[a.board_id]?.board_number || 0;
    const bb = boardMap[b.board_id]?.board_number || 0;
    return ba - bb;
  });

  return filtered.map((r, i) => {
    const board = boardMap[r.board_id];
    return { board, result: r, otherRoom: null, displayBoardNumber: i + 1 };
  });
}


// ── Board row with popup panels ──────────────────────────────────

function BoardRow({ row, isTeams, participantMap, boardResults, highlightParticipantId, ourParticipantId, supabase, userId, analysisId, analysisName, sharedWith, DiscussionView }) {
  const [popup, setPopup] = useState(null);
  const [notesDiscussion, setNotesDiscussion] = useState(null);
  const [notesLoading, setNotesLoading] = useState(false);

  const handleOpenNotes = async () => {
    if (notesDiscussion) {
      setPopup(popup === 'notes' ? null : 'notes');
      return;
    }
    setNotesLoading(true);
    const resourceId = `${analysisId}:${row.board.id}`;
    const resourceType = 'game_board';

    try {
      // Find existing discussion for this resource
      const { data: existing, error: findErr } = await supabase
        .from('discussions')
        .select('id, name, created_by')
        .eq('resource_type', resourceType)
        .eq('resource_id', resourceId)
        .limit(1);

      if (findErr) { console.error('Find discussion error:', findErr); setNotesLoading(false); return; }

      let disc = existing?.[0];
      if (disc) {
        // Ensure current user is a member (ignore if already exists)
        const { error: joinErr } = await supabase.from('discussion_members').insert(
          { discussion_id: disc.id, user_id: userId }
        );
        if (joinErr && !joinErr.message?.includes('duplicate')) console.error('Join error:', joinErr);
      }
      if (!disc) {
        // Create new discussion
        const { data: created, error: createErr } = await supabase
          .from('discussions')
          .insert({
            name: `Board ${row.displayBoardNumber ?? row.board.board_number} Notes`,
            created_by: userId,
            resource_type: resourceType,
            resource_id: resourceId,
          })
          .select('id, name, created_by')
          .single();

        if (createErr) { console.error('Create discussion error:', createErr); setNotesLoading(false); return; }

        if (created) {
          const members = [{ discussion_id: created.id, user_id: userId }];
          for (const s of (sharedWith || [])) {
            if (s.userId && s.userId !== userId) {
              members.push({ discussion_id: created.id, user_id: s.userId });
            }
          }
          for (const m of members) {
          await supabase.from('discussion_members').insert(m).then(() => {}, () => {});
        }
          disc = created;
        }
      }

      if (disc) {
        setNotesDiscussion(disc);
        setPopup('notes');
      } else {
        alert('Could not create or find discussion. Check browser console.');
      }
    } catch (e) {
      console.error('Notes error:', e);
      alert('Notes error: ' + e.message);
    }
    setNotesLoading(false);
  };

  if (!row.board) return null;

  // Compute optimal/alternate contract lines
  let pairsDDBest = null;
  let optLines = null;
  if (row.board && hasDDData(row.board) && row.result && !row.result.passed_out
      && row.result.declarer && row.result.contract_level) {
    const b = row.board;
    const r = row.result;
    const fieldScores = boardResults.length > 1 ? boardResults.map(x => x.score || 0) : null;
    const declarerIsNs = r.declarer === 'N' || r.declarer === 'S';
    const ourSideIsNs = ourParticipantId
      ? r.ns_participant_id === ourParticipantId
      : declarerIsNs;
    const ourSide = ourSideIsNs ? 'ns' : 'ew';
    const weAreDeclaring = ourSideIsNs === declarerIsNs;

    if (isTeams) {
      // Three categories of "Better" for teams:
      // 1. Declaring side's better contracts (higher-scoring contracts they could have bid)
      // 2. Better defense (DD says actual contract doesn't make at claimed tricks)
      // 3. Defending side's saves (outbid the contract, penalty less than conceded score)

      const declDirs = declarerIsNs ? ['n', 's'] : ['e', 'w'];
      const defDirs = declarerIsNs ? ['e', 'w'] : ['n', 's'];
      const declVul = isVul(declarerIsNs ? 'ns' : 'ew', b.vulnerability);
      const defVul = isVul(declarerIsNs ? 'ew' : 'ns', b.vulnerability);
      const nsScore = declarerIsNs ? (r.score || 0) : -(r.score || 0);
      const declActual = r.score || 0; // from declarer's perspective (positive = declarer scores)
      const defActual = -(r.score || 0); // from defender's perspective

      // Other room's contribution to IMP swing (from our team's perspective)
      let otherRoomOurScore = null;
      if (row.otherRoom && ourParticipantId) {
        const swapped = r.ns_participant_id === row.otherRoom.ew_participant_id;
        const otherNs = swapped ? -(row.otherRoom.score || 0) : (row.otherRoom.score || 0);
        otherRoomOurScore = ourSideIsNs ? otherNs : -otherNs;
      }

      const resultLines = [];
      const ourActualScore = ourSideIsNs ? nsScore : -nsScore;

      // 1. Declaring side's better contracts
      for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
        const denomKey = denom === 'NT' ? 'nt' : denom.toLowerCase();
        const isMinor = denom === 'C' || denom === 'D';
        let maxT = 0, bestDir = '';
        for (const dir of declDirs) {
          const t = b[`dd_${dir}_${denomKey}`];
          if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
        }
        if (maxT < 7) continue;
        const bestLevel = maxT - 6;
        const score = computeScore(bestLevel, denom, maxT, declVul, isMinor);
        if (score > declActual) {
          const ourScore = weAreDeclaring ? score : -score;
          const line = {
            type: 'alternate',
            contract: { level: bestLevel, denom, x: '', dir: bestDir, ot: 0 },
            ourScore,
          };
          if (otherRoomOurScore != null) line.imps = scoreToImps(ourScore + otherRoomOurScore);
          resultLines.push(line);
        }
      }

      // 2. Better defense — DD says actual contract makes fewer tricks
      if (r.contract_level && r.declarer && !r.passed_out) {
        const dDir = r.declarer.toLowerCase();
        const dk = r.contract_denom === 'NT' ? 'nt' : r.contract_denom.toLowerCase();
        const ddTricks = b[`dd_${dDir}_${dk}`];
        if (ddTricks != null && ddTricks < (r.tricks || 0)) {
          const needed = r.contract_level + 6;
          const isMin = r.contract_denom === 'C' || r.contract_denom === 'D';
          const x = r.contract_x || '';
          let ddDeclScore;
          if (ddTricks >= needed) {
            ddDeclScore = x === 'X' ? computeDoubledMaking(r.contract_level, r.contract_denom, ddTricks, declVul, isMin)
                                    : computeScore(r.contract_level, r.contract_denom, ddTricks, declVul, isMin);
          } else {
            const down = needed - ddTricks;
            ddDeclScore = x === 'X' ? doubledDownScore(down, declVul) : (declVul ? -100 * down : -50 * down);
          }
          if (ddDeclScore < declActual) {
            const ddOt = ddTricks - needed;
            const ourScore = weAreDeclaring ? ddDeclScore : -ddDeclScore;
            const line = {
              type: 'defense',
              contract: { level: r.contract_level, denom: r.contract_denom, x, dir: r.declarer, ot: ddOt },
              ourScore,
              tricks: ddTricks,
            };
            if (otherRoomOurScore != null) line.imps = scoreToImps(ourScore + otherRoomOurScore);
            resultLines.push(line);
          }
        }
      }

      // 3. Defending side's saves — must outbid the actual contract
      if (r.contract_level) {
        const actualLevel = r.contract_level;
        const actualDenomRank = denomRank(r.contract_denom);

        for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
          const denomKey = denom === 'NT' ? 'nt' : denom.toLowerCase();
          const saveDenomRank = denomRank(denom);
          // Minimum level to outbid the actual contract
          const minLevel = saveDenomRank > actualDenomRank ? actualLevel : actualLevel + 1;
          if (minLevel > 7) continue;

          let maxT = 0, bestDir = '';
          for (const dir of defDirs) {
            const t = b[`dd_${dir}_${denomKey}`];
            if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
          }

          const needed = minLevel + 6;
          let saveScore;
          if (maxT >= needed) {
            // Save actually makes — compute making score (from defender's perspective)
            const isMinor = denom === 'C' || denom === 'D';
            saveScore = computeScore(minLevel, denom, maxT, defVul, isMinor);
          } else {
            // Goes down — assume doubled
            const down = needed - maxT;
            saveScore = doubledDownScore(down, defVul);
          }

          // saveScore is from defender's perspective. Compare vs defActual.
          if (saveScore > defActual) {
            const down = Math.max(0, needed - maxT);
            const ot = maxT >= needed ? maxT - needed : -down;
            // From our team's perspective
            const ourScore = weAreDeclaring ? -saveScore : saveScore;
            const line = {
              type: 'save',
              contract: { level: minLevel, denom, x: down > 0 ? 'X' : '', dir: bestDir, ot },
              ourScore,
            };
            if (otherRoomOurScore != null) line.imps = scoreToImps(ourScore + otherRoomOurScore);
            resultLines.push(line);
          }
        }
      }

      if (resultLines.length > 0) {
        optLines = resultLines.sort((a, b) => b.ourScore - a.ourScore);
      }
    } else {
      // Pairs: DD optimal for our contract + better alternate contracts
      // IMP pairs compare via cross-IMPs against the other tables; MP pairs via MP%
      const impPairs = boardResults.some(x => x.imps_ns != null);
      const otherNsScores = impPairs
        ? boardResults.filter(x => x.id !== r.id).map(x => x.score || 0)
        : [];
      const crossImpsNs = (nsScore) => {
        if (!otherNsScores.length) return null;
        const total = otherNsScores.reduce((sum, s) => sum + scoreToImps(nsScore - s), 0);
        return Math.round((total / otherNsScores.length) * 10) / 10;
      };

      const dDir = r.declarer.toLowerCase();
      const dk = r.contract_denom === 'NT' ? 'nt' : r.contract_denom.toLowerCase();
      const ddTricks = b[`dd_${dDir}_${dk}`];

      if (ddTricks != null) {
        const needed = r.contract_level + 6;
        const declSide = declarerIsNs ? 'ns' : 'ew';
        const declVul = isVul(declSide, b.vulnerability);
        const isMin = r.contract_denom === 'C' || r.contract_denom === 'D';
        const x = r.contract_x || '';

        // DD score for actual contract
        let ddDeclScore;
        if (ddTricks >= needed) {
          ddDeclScore = x === 'X' ? computeDoubledMaking(r.contract_level, r.contract_denom, ddTricks, declVul, isMin)
                                  : computeScore(r.contract_level, r.contract_denom, ddTricks, declVul, isMin);
        } else {
          const down = needed - ddTricks;
          ddDeclScore = x === 'X' ? doubledDownScore(down, declVul) : (declVul ? -100 * down : -50 * down);
        }

        const ddOptimalForUs = weAreDeclaring ? ddDeclScore : -ddDeclScore;
        const ddOptNsScore = declarerIsNs ? ddDeclScore : -ddDeclScore;
        const ddOt = ddTricks - needed;

        const resultLines = [];

        // Line 1: DD optimal for our contract
        const optLine = {
          type: 'optimal',
          label: 'DD',
          contract: { level: r.contract_level, denom: r.contract_denom, x, dir: r.declarer, ot: ddOt },
          nsScore: ddOptNsScore,
          ourScore: ddOptimalForUs,
          tricks: ddTricks,
        };
        if (impPairs) {
          const impNs = crossImpsNs(ddOptNsScore);
          if (impNs != null) optLine.imps = ourSideIsNs ? impNs : -impNs;
        } else if (fieldScores) {
          optLine.nsMp = calcMpPct(ddOptNsScore, fieldScores, 'ns');
          optLine.ewMp = calcMpPct(-ddOptNsScore, fieldScores, 'ew');
        }
        resultLines.push(optLine);

        // Alternate contracts for our side that beat our ACTUAL result
        // (not just the DD par of the contract we played).
        // When the opponents declared, our alternative must OUTBID their
        // contract (a save), assumed doubled when it goes down.
        const ourActualScore = ourSideIsNs ? (r.score || 0) : -(r.score || 0);
        const ourDirs = ourSideIsNs ? ['n', 's'] : ['e', 'w'];
        const ourVul = isVul(ourSide, b.vulnerability);

        const pushAltLine = (type, contract, ourScore) => {
          const nsScore = ourSideIsNs ? ourScore : -ourScore;
          const altLine = { type, contract, nsScore, ourScore };
          if (impPairs) {
            const impNs = crossImpsNs(nsScore);
            if (impNs != null) altLine.imps = ourSideIsNs ? impNs : -impNs;
          } else if (fieldScores) {
            altLine.nsMp = calcMpPct(nsScore, fieldScores, 'ns');
            altLine.ewMp = calcMpPct(-nsScore, fieldScores, 'ew');
          }
          resultLines.push(altLine);
        };

        for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
          const denomKey = denom === 'NT' ? 'nt' : denom.toLowerCase();
          const isMinor = denom === 'C' || denom === 'D';
          let maxT = 0, bestDir = '';
          for (const dir of ourDirs) {
            const t = b[`dd_${dir}_${denomKey}`];
            if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
          }
          if (!bestDir) continue;

          if (weAreDeclaring) {
            // We won the auction — any makeable contract was available
            if (maxT < 7) continue;
            const bestLevel = maxT - 6;
            const bestScore = computeScore(bestLevel, denom, maxT, ourVul, isMinor);
            if (bestScore > ourActualScore) {
              pushAltLine('alternate',
                { level: bestLevel, denom, x: '', dir: bestDir, ot: maxT - (bestLevel + 6) },
                bestScore);
            }
          } else {
            // Opponents declared — we can only outbid them (save)
            const minLevel = denomRank(denom) > denomRank(r.contract_denom)
              ? r.contract_level : r.contract_level + 1;
            if (minLevel > 7) continue;
            const needed = minLevel + 6;
            let saveScore;
            if (maxT >= needed) {
              saveScore = computeScore(minLevel, denom, maxT, ourVul, isMinor);
            } else {
              saveScore = doubledDownScore(needed - maxT, ourVul);
            }
            if (saveScore > ourActualScore) {
              const down = Math.max(0, needed - maxT);
              pushAltLine('save',
                { level: minLevel, denom, x: down > 0 ? 'X' : '', dir: bestDir, ot: maxT >= needed ? maxT - needed : -down },
                saveScore);
            }
          }
        }

        // Sort alternates by score descending (keep DD optimal first)
        const optimal = resultLines[0];
        const alts = resultLines.slice(1).sort((a, b) => b.ourScore - a.ourScore);
        optLines = [optimal, ...alts];
      }
    }
  }

  return (
    <div className="border-b-2 border-gray-400 relative mb-3 pb-2">
      <div>
        <div>
          <div className="px-2 py-1">
            <HandDiagram
              board={row.board}
              result={row.result}
              otherRoom={row.otherRoom}
              participantMap={participantMap}
              ourParticipantId={ourParticipantId}
              isTeams={isTeams}
              ddBest={pairsDDBest}
              optimalLines={optLines}
              onOtherRoom={isTeams && row.otherRoom ? () => setPopup(popup === 'otherroom' ? null : 'otherroom') : undefined}
              onAnalysis={undefined}
              onTraveller={boardResults.length > 1 ? () => setPopup(popup === 'traveller' ? null : 'traveller') : undefined}
              boardNumber={row.displayBoardNumber ?? row.board.board_number}
              onNotes={supabase ? () => handleOpenNotes() : undefined}
              notesLoading={notesLoading}
              isImpPairs={!isTeams && boardResults.some(r => r.imps_ns != null)}
            />
          </div>
        </div>
      </div>

      {/* Popup overlay */}
      {popup && popup !== 'notes' && (
        <TravellerPopup
          popup={popup}
          board={row.board}
          result={row.result}
          otherRoom={row.otherRoom}
          boardResults={boardResults}
          participantMap={participantMap}
          highlightParticipantId={highlightParticipantId}
          ourParticipantId={ourParticipantId}
          isTeams={isTeams}
          onClose={() => setPopup(null)}
          boardNumber={row.displayBoardNumber ?? row.board.board_number}
        />
      )}

      {/* Notes discussion popup */}
      {popup === 'notes' && notesDiscussion && (
        <NotesPopup
          discussion={notesDiscussion}
          supabase={supabase}
          userId={userId}
          onClose={() => setPopup(null)}
          boardNumber={row.displayBoardNumber ?? row.board.board_number}
          analysisName={analysisName}
          DiscussionView={DiscussionView}
        />
      )}
    </div>
  );
}


function NotesPopup({ discussion, supabase, userId, onClose, boardNumber, analysisName, DiscussionView }) {
  const [pos, setPos] = useState({ x: null, y: null });
  const dragRef = React.useRef(null);

  const handleMouseDown = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
    const el = dragRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const onMove = (ev) => setPos({ x: ev.clientX - offsetX, y: ev.clientY - offsetY });
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  if (DiscussionView) {
    const style = pos.x != null
      ? { position: 'fixed', left: pos.x, top: pos.y, zIndex: 50, cursor: 'move' }
      : { position: 'fixed', right: 0, top: 0, zIndex: 50, cursor: 'move' };

    return (
      <div ref={dragRef} style={style} onMouseDown={handleMouseDown} onClick={(e) => e.stopPropagation()}>
        <DiscussionView
          discussion={discussion}
          supabase={supabase}
          userId={userId}
          isOwner={discussion.created_by === userId}
          onClose={onClose}
          documentName={analysisName || ''}
          docId={null}
          hideUnlink
        />
      </div>
    );
  }

  // Fallback: simple inline notes for standalone mode
  return <NotesPopupFallback discussion={discussion} supabase={supabase} userId={userId} onClose={onClose} boardNumber={boardNumber} />;
}

function NotesPopupFallback({ discussion, supabase, userId, onClose, boardNumber }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = React.useRef(null);

  React.useEffect(() => {
    supabase
      .from('discussion_messages')
      .select('id, content, user_id, created_at')
      .eq('discussion_id', discussion.id)
      .eq('deleted', false)
      .order('created_at')
      .then(({ data }) => setMessages(data || []));
  }, [discussion.id]);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    const { data } = await supabase
      .from('discussion_messages')
      .insert({ discussion_id: discussion.id, user_id: userId, content: text })
      .select('id, content, user_id, created_at')
      .single();
    if (data) setMessages(prev => [...prev, data]);
    setInput('');
    setSending(false);
  };

  const panel = (
    <>
      <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between z-10">
        <span className="text-sm font-bold text-gray-700">Board {boardNumber} — Notes</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3" style={{ minHeight: 200 }}>
        {messages.length === 0 && <p className="text-sm text-gray-400">No notes yet.</p>}
        {messages.map(m => (
          <div key={m.id} className={`text-sm ${m.user_id === userId ? 'text-right' : ''}`}>
            <div className={`inline-block px-3 py-2 rounded-lg max-w-[80%] ${m.user_id === userId ? 'bg-blue-100 text-gray-800' : 'bg-gray-100 text-gray-700'}`}>
              {m.content}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-200 p-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Add a note..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
          autoFocus
        />
        <button onClick={handleSend} disabled={!input.trim() || sending}
          className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
          Send
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="hidden md:flex flex-col fixed right-0 top-0 bottom-0 bg-white border-l border-gray-200 shadow-lg z-30"
           style={{ width: '45%', maxWidth: '500px', minWidth: '350px' }}>
        {panel}
      </div>
      <div className="md:hidden fixed inset-0 bg-white z-50 flex flex-col">
        {panel}
      </div>
    </>
  );
}


function TravellerPopup({ popup, board, result, otherRoom, boardResults, participantMap,
                           highlightParticipantId, ourParticipantId, isTeams, onClose, boardNumber }) {
  const popupTitle = popup === 'traveller' ? 'Traveller'
    : popup === 'otherroom' ? 'Other Room'
    : 'Analysis';

  const popupContent = popup === 'traveller' ? (
    <TravellerTable
      boardResults={boardResults}
      participantMap={participantMap}
      highlightParticipantId={highlightParticipantId}
      isTeams={isTeams}
    />
  ) : popup === 'otherroom' && board && otherRoom ? (
    <HandDiagram
      board={board}
      result={otherRoom}
      otherRoom={null}
      participantMap={participantMap}
      ourParticipantId={ourParticipantId}
    />
  ) : popup === 'analysis' ? (
    <AnalysisPanel
      board={board}
      result={result}
      otherRoom={otherRoom}
      boardResults={boardResults}
      participantMap={participantMap}
      highlightParticipantId={highlightParticipantId}
      ourParticipantId={ourParticipantId}
      isTeams={isTeams}
    />
  ) : null;

  return (
    <>
      {/* Desktop: fixed to the right side of viewport */}
      <div className="hidden md:block fixed right-0 top-0 bottom-0 bg-white border-l border-gray-200 shadow-lg z-30 overflow-auto"
           style={{ width: '45%', maxWidth: '650px', minWidth: '450px' }}>
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between z-10">
          <span className="text-sm font-bold text-gray-700">
            Board {boardNumber} — {popupTitle}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>
        <div className="p-4">{popupContent}</div>
      </div>

      {/* Mobile: full-screen overlay */}
      <div className="md:hidden fixed inset-0 bg-white z-50 overflow-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
          <span className="text-sm font-bold text-gray-700">
            Board {boardNumber} — {popupTitle}
          </span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-lg leading-none">&times;</button>
        </div>
        <div className="p-4">{popupContent}</div>
      </div>
    </>
  );
}


// ── Sortable traveller table (pairs + teams) ─────────────────────

const SUIT_SYMBOLS_T = { S: '♠', H: '♥', D: '♦', C: '♣' };
const DENOM_ORDER = { C: 0, D: 1, H: 2, S: 3, NT: 4 };
function denomRank(d) { return DENOM_ORDER[d] ?? -1; }

function TravellerTable({ boardResults, participantMap, highlightParticipantId, isTeams }) {
  const [sortKey, setSortKey] = useState('ns');
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState(null);

  if (!boardResults.length) return null;

  const isImpPairs = !isTeams && boardResults.some(r => r.imps_ns != null);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortIndicator = (key) => {
    if (sortKey !== key) return '';
    return sortAsc ? ' ▲' : ' ▼';
  };

  const sorted = sortKey ? [...boardResults].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (a.passed_out && !b.passed_out) return 1;
    if (!a.passed_out && b.passed_out) return -1;

    let cmp = 0;
    switch (sortKey) {
      case 'contract': {
        cmp = (a.contract_level || 0) - (b.contract_level || 0);
        if (cmp === 0) cmp = (DENOM_ORDER[a.contract_denom] || 0) - (DENOM_ORDER[b.contract_denom] || 0);
        if (cmp === 0) cmp = (a.declarer || '').localeCompare(b.declarer || '');
        if (cmp === 0) cmp = (b.tricks || 0) - (a.tricks || 0);
        break;
      }
      case 'tricks': cmp = (a.tricks || 0) - (b.tricks || 0); break;
      case 'score': cmp = (a.score || 0) - (b.score || 0); break;
      case 'lead': cmp = (a.lead || '').localeCompare(b.lead || ''); break;
      case 'ns': cmp = (participantMap[a.ns_participant_id]?.number || 0) - (participantMap[b.ns_participant_id]?.number || 0); break;
      case 'ew': cmp = (participantMap[a.ew_participant_id]?.number || 0) - (participantMap[b.ew_participant_id]?.number || 0); break;
      case 'pct': {
        const pa = pctVal(a); const pb = pctVal(b);
        cmp = (pa ?? -1) - (pb ?? -1); break;
      }
      case 'imps': cmp = (a.imps_ns || 0) - (b.imps_ns || 0); break;
      case 'room': cmp = (a.room || '').localeCompare(b.room || ''); break;
      default: break;
    }
    return cmp * dir;
  }) : boardResults;

  const thClass = "py-1.5 px-1.5 text-left font-medium cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap";

  return (
    <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr className="border-b border-gray-300 text-gray-600 bg-gray-50">
          <th className={thClass} onClick={() => handleSort('ns')}>NS{sortIndicator('ns')}</th>
          <th className={thClass} onClick={() => handleSort('ew')}>EW{sortIndicator('ew')}</th>
          <th className={thClass} onClick={() => handleSort('contract')}>Contract{sortIndicator('contract')}</th>
          <th className={`${thClass} text-center`} onClick={() => handleSort('tricks')}>Tricks{sortIndicator('tricks')}</th>
          <th className={thClass} onClick={() => handleSort('lead')}>Lead{sortIndicator('lead')}</th>
          <th className={`${thClass} text-right`} onClick={() => handleSort('score')}>Score{sortIndicator('score')}</th>
          {isTeams && <th className={`${thClass} text-center`} onClick={() => handleSort('room')}>Room{sortIndicator('room')}</th>}
          {isTeams || isImpPairs
            ? <th className={`${thClass} text-right`} onClick={() => handleSort('imps')}>IMPs{sortIndicator('imps')}</th>
            : <th className={`${thClass} text-right`} onClick={() => handleSort('pct')}>MP%{sortIndicator('pct')}</th>
          }
          <th className="py-1.5 px-1.5 text-center font-medium text-gray-600"></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => {
          const hl = highlightParticipantId &&
            (r.ns_participant_id === highlightParticipantId ||
             r.ew_participant_id === highlightParticipantId);
          const nsName = participantMap[r.ns_participant_id]?.name || '';
          const ewName = participantMap[r.ew_participant_id]?.name || '';
          const pct = pctVal(r);
          const scoreStr = r.score > 0 ? `+${r.score}` : `${r.score}`;

          const hasBidding = r.lin && /mb\|[^|]+\|/.test(r.lin);
          const isExpanded = expandedIdx === i;
          const colCount = isTeams ? 9 : 8;

          return (
            <React.Fragment key={i}>
              <tr className={`border-b border-gray-50 ${hl ? 'bg-blue-50 font-semibold' : 'hover:bg-gray-50'} ${hasBidding ? 'cursor-pointer' : ''}`}
                onClick={hasBidding ? () => setExpandedIdx(isExpanded ? null : i) : undefined}>
                <td className="py-1 px-1.5 truncate max-w-[90px]" title={nsName}>{shortPairName(nsName)}</td>
                <td className="py-1 px-1.5 truncate max-w-[90px]" title={ewName}>{shortPairName(ewName)}</td>
                <td className="py-1 px-1.5">
                  {r.passed_out ? 'Pass' : (
                    <>
                      {r.contract_level}
                      <span style={{ color: suitColor(r.contract_denom) }}>{SUIT_SYMBOLS_T[r.contract_denom] || r.contract_denom}</span>
                      {r.contract_x || ''}
                      <span className="text-gray-400 ml-0.5">{r.declarer}</span>
                    </>
                  )}
                </td>
                <td className="py-1 px-1.5 text-center">{r.passed_out ? '' : r.tricks}</td>
                <td className="py-1 px-1.5">
                  {r.lead_suit && (<><span style={{ color: suitColor(r.lead_suit) }}>{SUIT_SYMBOLS_T[r.lead_suit]}</span>{r.lead_rank}</>)}
                </td>
                <td className="py-1 px-1.5 text-right font-mono">{r.passed_out ? '' : scoreStr}</td>
                {isTeams && <td className="py-1 px-1.5 text-center text-gray-400">{r.room === 'open' ? 'O' : 'C'}</td>}
                {isTeams || isImpPairs
                  ? <td className={`py-1 px-1.5 text-right font-medium ${(r.imps_ns || 0) > 0 ? 'text-green-700' : (r.imps_ns || 0) < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                      {r.imps_ns != null ? (r.imps_ns > 0 ? `+${r.imps_ns}` : r.imps_ns) : ''}
                    </td>
                  : <td className="py-1 px-1.5 text-right">{pct != null && <PctBadge pct={pct} />}</td>
                }
                <td className="py-1 px-1.5 text-center">
                  {r.lin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openHandviewer(r.lin); }}
                      className="px-1.5 py-0.5 rounded text-xs bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      Open
                    </button>
                  )}
                </td>
              </tr>
              {isExpanded && (
                <tr>
                  <td colSpan={colCount} className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <BiddingTable lin={r.lin} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function pctVal(r) {
  const maxMp = (r.mp_ns || 0) + (r.mp_ew || 0);
  return maxMp > 0 ? Math.round(((r.mp_ns || 0) / maxMp) * 100) : null;
}

function PctBadge({ pct }) {
  let color = 'text-red-600';
  if (pct >= 65) color = 'text-green-700';
  else if (pct >= 45) color = 'text-gray-600';
  return <span className={`font-medium ${color}`}>{pct}%</span>;
}

function shortPairName(name) {
  if (!name) return '';
  const parts = name.split(/\s*[&-]\s*/);
  if (parts.length >= 2) {
    return parts.map(p => {
      const words = p.trim().split(/\s+/);
      if (words.length >= 2) return words[0].charAt(0) + '. ' + words[words.length - 1];
      return words[0];
    }).join(' & ');
  }
  if (name.length > 12) return name.substring(0, 12) + '…';
  return name;
}

function suitColor(d) {
  switch (d) {
    case 'S': return '#000';
    case 'H': case 'D': return '#c62828';
    case 'C': return '#2e7d32';
    default: return '#333';
  }
}


// ── Inline bidding in traveller ───────────────────────────────────

function InlineBidding({ lin }) {
  if (!lin) return null;
  const mbMatch = lin.match(/mb\|([^|]*)\|/);
  if (!mbMatch || !mbMatch[1]) return <span className="text-gray-400 text-xs">No bidding data</span>;

  const dealerMatch = lin.match(/md\|(\d)/);
  const linDealer = dealerMatch ? parseInt(dealerMatch[1]) : 3;
  const linDirOrder = ['S', 'W', 'N', 'E'];
  const startDir = linDirOrder[linDealer - 1] || 'N';

  const dirs = ['W', 'N', 'E', 'S'];
  const startIdx = dirs.indexOf(startDir);

  const bids = [];
  const regex = /([1-7][CDHSN]T?|P|X{1,2})/gi;
  let m;
  while ((m = regex.exec(mbMatch[1])) !== null) {
    bids.push(m[1].toUpperCase());
  }
  if (!bids.length) return null;

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
    <table className="text-xs border-collapse" style={{ minWidth: '160px' }}>
      <thead>
        <tr className="border-b border-gray-300">
          {dirs.map(d => <th key={d} className="px-2 py-0.5 text-center font-bold text-gray-500" style={{ width: '25%' }}>{d}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-gray-100">
            {row.map((cell, j) => (
              <td key={j} className="px-2 py-0.5 text-center">{cell === null ? '' : fmtBid(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmtBid(bid) {
  if (!bid) return '';
  if (bid === 'P') return <span className="text-green-700">Pass</span>;
  if (bid === 'X') return <span className="text-red-600 font-bold">X</span>;
  if (bid === 'XX') return <span className="text-blue-600 font-bold">XX</span>;
  const level = bid[0];
  const ds = bid.substring(1);
  const map = { C: ['♣','#2e7d32'], D: ['♦','#c62828'], H: ['♥','#c62828'], S: ['♠','#000'], NT: ['NT','#333'], N: ['NT','#333'] };
  const [sym, col] = map[ds] || [ds, '#333'];
  return <span>{level}<span style={{ color: col, fontWeight: 'bold' }}>{sym}</span></span>;
}


// ── Bidding analysis ─────────────────────────────────────────────

function hasDefenderBidHigh(result) {
  if (!result?.lin) return false;

  const declarer = result.declarer;
  if (!declarer) return false;

  const declarerSide = (declarer === 'N' || declarer === 'S') ? 'NS' : 'EW';

  // Extract bidding from LIN: mb|1Cp2Hp...|
  const mbMatch = result.lin.match(/mb\|([^|]*)\|/);
  if (!mbMatch) return false;

  const biddingStr = mbMatch[1];
  // Parse bids — each bid is like P, 1C, 2H, 3NT, X, XX
  // We need to track direction: starts from dealer, goes clockwise
  const dealerMatch = result.lin.match(/md\|(\d)/);
  if (!dealerMatch) return false;

  const dealerIdx = parseInt(dealerMatch[1]);
  // LIN dealer: 1=S, 2=W, 3=N, 4=E
  const dirOrder = ['S', 'W', 'N', 'E'];
  let currentDirIdx = dealerIdx - 1; // 0-based

  // Parse individual bids from the bidding string
  const bidRegex = /([1-7][CDHSN]T?|P|X{1,2})/gi;
  let m;
  while ((m = bidRegex.exec(biddingStr)) !== null) {
    const bid = m[1].toUpperCase();
    const dir = dirOrder[currentDirIdx % 4];
    const side = (dir === 'N' || dir === 'S') ? 'NS' : 'EW';

    // Check if this is the defending side and bid is 3+ level
    if (side !== declarerSide && bid.length >= 2 && bid !== 'XX') {
      const level = parseInt(bid[0]);
      if (!isNaN(level) && level >= 3) return true;
    }

    currentDirIdx++;
  }

  return false;
}


// ── Analysis panel ──────────────────────────────────────────────

const SUIT_SYM_A = { S: '♠', H: '♥', D: '♦', C: '♣' };

function AnalysisPanel({ board, result, otherRoom, boardResults, participantMap,
                          highlightParticipantId, ourParticipantId, isTeams }) {
  if (!board) return null;

  const nsVul = isVul('ns', board.vulnerability);
  const ewVul = isVul('ew', board.vulnerability);
  const ns = bestDDContract(board, 'ns', nsVul);
  const ew = bestDDContract(board, 'ew', ewVul);

  const resultLines = [];

  if (result && hasDDData(board) && !result.passed_out) {
    const r = result;
    const declarer = r.declarer;
    const declarerIsNs = declarer === 'N' || declarer === 'S';
    const declarerSide = declarerIsNs ? 'ns' : 'ew';
    const defenderSide = declarerIsNs ? 'ew' : 'ns';
    const nsScore = r.score || 0;

    // Other room data for teams
    let otherRoomNsScore = null;
    if (isTeams && otherRoom) {
      const swapped = r.ns_participant_id === otherRoom.ew_participant_id;
      otherRoomNsScore = swapped ? -(otherRoom.score || 0) : (otherRoom.score || 0);
    }

    // 1. Best for declaring side: best DD-makeable contract
    const declBest = declarerIsNs ? ns : ew;
    if (declBest) {
      const declActualScore = declarerIsNs ? nsScore : -nsScore;
      if (declBest.score > declActualScore) {
        const declNsScore = declarerIsNs ? declBest.score : -declBest.score;
        resultLines.push({
          label: declarerSide.toUpperCase(),
          contract: { level: declBest.level, denom: declBest.denom, x: '', dir: declBest.dir, ot: declBest.tricks - (declBest.level + 6) },
          nsScore: declNsScore,
        });
      }
    }

    // 2. Best for defending side: DD defense or competing contract
    let bestForDefender = null;
    const defActualScore = defenderSide === 'ns' ? nsScore : -nsScore;

    // a. DD defense of actual contract
    const dDir = declarer.toLowerCase();
    const dk = (r.contract_denom === 'NT') ? 'nt' : r.contract_denom.toLowerCase();
    const ddTricks = board[`dd_${dDir}_${dk}`];
    const needed = r.contract_level + 6;

    if (ddTricks != null && ddTricks < r.tricks) {
      const declVul = isVul(declarerSide, board.vulnerability);
      const isMin = r.contract_denom === 'C' || r.contract_denom === 'D';
      const x = r.contract_x;
      let ddDS;
      if (ddTricks >= needed) {
        ddDS = x === 'X' ? computeDoubledMaking(r.contract_level, r.contract_denom, ddTricks, declVul, isMin)
                         : computeScore(r.contract_level, r.contract_denom, ddTricks, declVul, isMin);
      } else {
        const dn = needed - ddTricks;
        ddDS = x === 'X' ? doubledDownScore(dn, declVul) : (declVul ? -100 * dn : -50 * dn);
      }
      const ddNsScore = declarerIsNs ? ddDS : -ddDS;
      const ddDefScore = defenderSide === 'ns' ? ddNsScore : -ddNsScore;

      if (ddDefScore > defActualScore) {
        bestForDefender = {
          contract: { level: r.contract_level, denom: r.contract_denom, x: x || '', dir: declarer, ot: ddTricks - needed },
          nsScore: ddNsScore,
        };
      }
    }

    // b. Competing contracts for defender
    const defVul = isVul(defenderSide, board.vulnerability);
    const defDirs = defenderSide === 'ns' ? ['n', 's'] : ['e', 'w'];
    const defFloor = bestForDefender ? (defenderSide === 'ns' ? bestForDefender.nsScore : -bestForDefender.nsScore) : defActualScore;

    for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
      const denomKey = denom === 'NT' ? 'nt' : denom.toLowerCase();
      const isMinor = denom === 'C' || denom === 'D';
      let maxT = 0, bestDir = '';
      for (const dir of defDirs) {
        const t = board[`dd_${dir}_${denomKey}`];
        if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
      }
      if (maxT === 0) continue;

      const minLevel = (SUIT_RANK[r.contract_denom] || 0) < (SUIT_RANK[denom] || 0) ? r.contract_level : r.contract_level + 1;

      for (let level = minLevel; level <= 7; level++) {
        const down = Math.max(0, (level + 6) - maxT);
        const ot = maxT - (level + 6);
        const undoubled = down === 0 ? computeScore(level, denom, maxT, defVul, isMinor) : (defVul ? -100 * down : -50 * down);
        const doubled = down === 0 ? computeDoubledMaking(level, denom, maxT, defVul, isMinor) : doubledDownScore(down, defVul);

        if (undoubled <= defFloor || doubled <= defActualScore) continue;

        const altNs = defenderSide === 'ns' ? undoubled : -undoubled;
        const altDefScore = defenderSide === 'ns' ? altNs : -altNs;
        if (!bestForDefender || altDefScore > (defenderSide === 'ns' ? bestForDefender.nsScore : -bestForDefender.nsScore)) {
          bestForDefender = {
            contract: { level, denom, x: '', dir: bestDir, ot: ot >= 0 ? ot : -down },
            nsScore: altNs,
          };
        }
        break;
      }
    }

    if (bestForDefender) {
      bestForDefender.label = defenderSide.toUpperCase();
      resultLines.push(bestForDefender);
    }

    // Add IMPs (teams) or MP% (pairs)
    for (const line of resultLines) {
      if (isTeams && otherRoomNsScore != null) {
        const ourSideNs = ourParticipantId ? r.ns_participant_id === ourParticipantId : true;
        const ourScore = ourSideNs ? line.nsScore : -line.nsScore;
        const ourOther = ourSideNs ? otherRoomNsScore : -otherRoomNsScore;
        line.imps = scoreToImps(ourScore + ourOther);
      }
      if (!isTeams && boardResults.length > 1) {
        const fieldScores = boardResults.map(x => x.score || 0);
        line.nsMp = calcMpPct(line.nsScore, fieldScores, 'ns');
        line.ewMp = calcMpPct(-line.nsScore, fieldScores, 'ew');
      }
    }
  }

  return (
    <div>
      {/* Best for NS / Best for EW */}
      {resultLines.length > 0 ? (
        <div className="space-y-2">
          {resultLines.map((line, i) => {
            const c = line.contract;
            const otStr = c.ot > 0 ? `+${c.ot}` : c.ot < 0 ? `↓${Math.abs(c.ot)}` : '=';
            const sideScore = line.label === 'NS' ? line.nsScore : -line.nsScore;
            const scoreStr = sideScore > 0 ? `+${sideScore}` : `${sideScore}`;
            const metric = isTeams && line.imps != null
              ? <span className="text-green-700 font-semibold ml-2">{line.imps > 0 ? '+' : ''}{line.imps} IMPs</span>
              : (line.label === 'NS' && line.nsMp != null)
                ? <span className="text-green-700 font-semibold ml-2">{Math.round(line.nsMp)}%</span>
                : (line.label === 'EW' && line.ewMp != null)
                  ? <span className="text-green-700 font-semibold ml-2">{Math.round(line.ewMp)}%</span>
                  : null;

            return (
              <div key={i} className="text-sm">
                <span className="font-bold text-amber-800">Best for {line.label}: </span>
                <span className="font-semibold">
                  {c.level}<span style={{ color: suitColor(c.denom) }}>{SUIT_SYM_A[c.denom] || c.denom}</span>{c.x}
                </span>
                <span className="text-gray-500"> by {c.dir} {otStr} ({scoreStr})</span>
                {metric}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-sm text-gray-400">No improvements found per DD analysis.</div>
      )}
    </div>
  );
}


function bestDDContract(board, side, vul) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  let best = null;
  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    const isMinor = denom === 'C' || denom === 'D';
    let maxT = 0, bestDir = '';
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${dk}`];
      if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
    }
    if (maxT < 7) continue;
    const maxLevel = maxT - 6;
    const sc = computeScore(maxLevel, denom, maxT, vul, isMinor);
    if (!best || sc > best.score || (sc === best.score && maxLevel > best.level)) {
      best = { level: maxLevel, denom, dir: bestDir, tricks: maxT, score: sc };
    }
  }
  return best;
}


function doubledDownScore(down, vul) {
  if (down <= 0) return 0;
  if (!vul) {
    let s = -100;
    if (down >= 2) s -= 200;
    if (down >= 3) s -= 200;
    for (let i = 4; i <= down; i++) s -= 300;
    return s;
  } else {
    let s = -200;
    for (let i = 2; i <= down; i++) s -= 300;
    return s;
  }
}

const SUIT_RANK = { C: 1, D: 2, H: 3, S: 4, NT: 5 };

function buildCompetingAnalysis(board, side, vul, actualScore, otherRoomOurScore, opLevel, opDenom) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];

  // Collect all denomination data: { denom, tricks, dir }
  const denomData = [];
  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    let maxT = 0, bestDir = '';
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${dk}`];
      if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
    }
    if (maxT === 0) continue;
    const minLevel = (SUIT_RANK[denom] || 0) > (SUIT_RANK[opDenom] || 0) ? opLevel : opLevel + 1;
    denomData.push({ denom, tricks: maxT, dir: bestDir, minLevel });
  }

  // Group denoms with same tricks and same minLevel
  const groups = {};
  for (const d of denomData) {
    const key = `${d.tricks}_${d.minLevel}`;
    if (!groups[key]) groups[key] = { tricks: d.tricks, minLevel: d.minLevel, denoms: [], dir: d.dir };
    groups[key].denoms.push(d.denom);
  }

  // Build lines: for each level, undoubled and doubled
  const lines = [];
  const isMinorMap = { C: true, D: true, H: false, S: false, NT: false };

  for (const g of Object.values(groups)) {
    for (let level = g.minLevel; level <= 7; level++) {
      const needed = level + 6;
      const down = Math.max(0, needed - g.tricks);

      const undoubledScore = down === 0
        ? computeScore(level, g.denoms[0], g.tricks, vul, isMinorMap[g.denoms[0]])
        : (vul ? -100 * down : -50 * down);

      const doubledScore = down === 0
        ? computeDoubledMaking(level, g.denoms[0], g.tricks, vul, isMinorMap[g.denoms[0]])
        : doubledDownScore(down, vul);

      if (undoubledScore <= actualScore && doubledScore <= actualScore) break;

      const undoubledImps = scoreToImps(undoubledScore + otherRoomOurScore);
      const doubledImps = scoreToImps(doubledScore + otherRoomOurScore);

      if (undoubledScore > actualScore) {
        lines.push({ denoms: g.denoms, level, doubled: false, down, score: undoubledScore, imps: undoubledImps });
      }
      if (doubledScore > actualScore && doubledScore !== undoubledScore && doubledImps > undoubledImps) {
        lines.push({ denoms: g.denoms, level, doubled: true, down, score: doubledScore, imps: doubledImps });
      }
    }
  }

  return lines;
}

function computeDoubledMaking(level, denom, tricks, vul, isMinor) {
  const ot = tricks - (level + 6);
  let ts = isMinor ? level * 40 : denom === 'NT' ? 80 + (level - 1) * 60 : level * 60;
  const isGame = ts >= 100;
  let score = ts + 50 + ot * (vul ? 200 : 100);
  if (level === 7) score += vul ? 1500 : 1000;
  else if (level === 6) score += vul ? 750 : 500;
  if (isGame) score += vul ? 500 : 300;
  else score += 50;
  return score;
}


function CompetingSection({ side, data }) {
  if (!data.length) return null;

  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded">
      <div className="text-sm font-bold text-amber-800 mb-2">{side} can gain:</div>
      <div className="space-y-1">
        {data.map((line, i) => {
          const xStr = line.doubled ? 'X' : '';
          const resultStr = line.down > 0 ? ` down ${line.down}`
            : line.overtricks > 0 ? ` +${line.overtricks}`
            : line.overtricks === 0 ? ' =' : '';
          const scoreStr = line.score > 0 ? `+${line.score}` : `${line.score}`;

          return (
            <div key={i} className="text-sm">
              <span className="font-semibold">
                {line.denoms.map((d, j) => (
                  <span key={d}>
                    {j > 0 && '/'}
                    {line.level}<span style={{ color: suitColor(d) }}>{SUIT_SYM_A[d] || d}</span>
                  </span>
                ))}{xStr}
                {line.declarer && <span className="text-gray-500 font-normal"> by {line.declarer}</span>}
              </span>
              <span className="text-gray-500">{resultStr} ({scoreStr})</span>
              {line.imps != null && (
                <span className="text-green-700 font-semibold ml-2">
                  {line.imps > 0 ? '+' : ''}{line.imps} IMPs
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function findOptimalContract(board, side, vul, fixedOtherScore) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  let best = null;

  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    const isMinor = denom === 'C' || denom === 'D';
    let maxT = 0, bestDir = '';
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${dk}`];
      if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
    }
    if (maxT === 0) continue;

    for (let level = 1; level <= 7; level++) {
      const needed = level + 6;
      let sc;
      if (maxT >= needed) {
        sc = computeScore(level, denom, maxT, vul, isMinor);
      } else {
        const down = needed - maxT;
        sc = vul ? -100 * down : -50 * down;
      }

      const swing = sc + fixedOtherScore;
      const imps = scoreToImps(swing);
      const ot = maxT - needed;

      if (!best || imps > best.imps || (imps === best.imps && sc > best.score)) {
        best = { level, denom, dir: bestDir, tricks: maxT, score: sc, imps, overtricks: ot };
      }
    }
  }
  return best;
}


function buildPairsCompetingAnalysis(board, side, vul, actualScore, fieldScores, opLevel, opDenom) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  const denomData = [];

  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    const isMinor = denom === 'C' || denom === 'D';
    let maxT = 0, bestDir = '';
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${dk}`];
      if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
    }
    if (maxT === 0) continue;
    const minLevel = (SUIT_RANK[denom] || 0) > (SUIT_RANK[opDenom] || 0) ? opLevel : opLevel + 1;
    denomData.push({ denom, tricks: maxT, dir: bestDir, minLevel, isMinor });
  }

  const groups = {};
  for (const d of denomData) {
    const key = `${d.tricks}_${d.minLevel}`;
    if (!groups[key]) groups[key] = { tricks: d.tricks, minLevel: d.minLevel, denoms: [], dir: d.dir, isMinor: d.isMinor };
    groups[key].denoms.push(d.denom);
  }

  const lines = [];
  const isMinorMap = { C: true, D: true, H: false, S: false, NT: false };

  for (const g of Object.values(groups)) {
    for (let level = g.minLevel; level <= 7; level++) {
      const needed = level + 6;
      const down = Math.max(0, needed - g.tricks);

      const undoubledScore = down === 0
        ? computeScore(level, g.denoms[0], g.tricks, vul, isMinorMap[g.denoms[0]])
        : (vul ? -100 * down : -50 * down);

      const doubledScore = down === 0
        ? computeDoubledMaking(level, g.denoms[0], g.tricks, vul, isMinorMap[g.denoms[0]])
        : doubledDownScore(down, vul);

      if (undoubledScore <= actualScore && doubledScore <= actualScore) break;

      const nsUndoubled = side === 'ns' ? undoubledScore : -undoubledScore;
      const nsDoubled = side === 'ns' ? doubledScore : -doubledScore;
      const undoubledMp = calcMpPct(nsUndoubled, fieldScores, side);
      const doubledMp = calcMpPct(nsDoubled, fieldScores, side);

      if (undoubledScore > actualScore) {
        lines.push({ denoms: g.denoms, level, doubled: false, down, score: undoubledScore, mpPct: undoubledMp });
      }
      if (doubledScore > actualScore && doubledScore !== undoubledScore && doubledMp > undoubledMp) {
        lines.push({ denoms: g.denoms, level, doubled: true, down, score: doubledScore, mpPct: doubledMp });
      }
    }
  }

  return lines;
}

function PairsCompetingSection({ side, data, actualMp }) {
  if (!data.length) return null;
  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded">
      <div className="text-sm font-bold text-amber-800 mb-2">
        {side} can gain <span className="font-normal text-gray-500">(actual {Math.round(actualMp)}%)</span>
      </div>
      <div className="space-y-1">
        {data.map((line, i) => {
          const xStr = line.doubled ? 'X' : '';
          const resultStr = line.down > 0 ? ` down ${line.down}`
            : line.overtricks > 0 ? ` +${line.overtricks}`
            : line.overtricks === 0 ? ' =' : '';
          const scoreStr = line.score > 0 ? `+${line.score}` : `${line.score}`;
          return (
            <div key={i} className="text-sm">
              <span className="font-semibold">
                {line.denoms.map((d, j) => (
                  <span key={d}>
                    {j > 0 && '/'}
                    {line.level}<span style={{ color: suitColor(d) }}>{SUIT_SYM_A[d] || d}</span>
                  </span>
                ))}{xStr}
                {line.declarer && <span className="text-gray-500 font-normal"> by {line.declarer}</span>}
              </span>
              <span className="text-gray-500">{resultStr} ({scoreStr})</span>
              {line.mpPct != null && <span className="text-green-700 font-semibold ml-2">→ {Math.round(line.mpPct)}%</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function hasDDData(board) { return board.dd_n_nt != null || board.dd_s_nt != null; }

function calcMpPct(ourScore, fieldScores, ourSide) {
  let mp = 0, count = 0;
  for (const s of fieldScores) {
    const theirNsScore = s;
    const theirScore = ourSide === 'ns' ? theirNsScore : -theirNsScore;
    if (ourScore > theirScore) mp += 2;
    else if (ourScore === theirScore) mp += 1;
    count++;
  }
  return count > 0 ? (mp / (2 * count)) * 100 : 50;
}

function findPairsOptimal(board, side, vul, fieldScores) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  let best = null;

  for (const denom of ['C', 'D', 'H', 'S', 'NT']) {
    const dk = denom === 'NT' ? 'nt' : denom.toLowerCase();
    const isMinor = denom === 'C' || denom === 'D';
    let maxT = 0, bestDir = '';
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${dk}`];
      if (t != null && t > maxT) { maxT = t; bestDir = dir.toUpperCase(); }
    }
    if (maxT === 0) continue;

    for (let level = 1; level <= 7; level++) {
      const needed = level + 6;
      const ot = maxT - needed;
      let sc;
      if (ot >= 0) {
        sc = computeScore(level, denom, maxT, vul, isMinor);
      } else {
        const down = -ot;
        sc = vul ? -100 * down : -50 * down;
      }

      const ourScore = side === 'ns' ? sc : -sc;
      const mpPct = calcMpPct(ourScore, fieldScores, side);

      if (!best || mpPct > best.mpPct || (mpPct === best.mpPct && sc > best.score)) {
        best = { level, denom, dir: bestDir, tricks: maxT, score: sc, overtricks: ot, mpPct };
      }
    }
  }
  return best;
}

// ── IMP table ───────────────────────────────────────────────────

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


// ── Suboptimal contract detection ────────────────────────────────

function bestDDScore(board, side, vul) {
  const dirs = side === 'ns' ? ['n', 's'] : ['e', 'w'];
  const denoms = [
    { key: 'c', minor: true },
    { key: 'd', minor: true },
    { key: 'h', minor: false },
    { key: 's', minor: false },
    { key: 'nt', minor: false },
  ];

  let best = 0;
  for (const { key, minor } of denoms) {
    let maxTricks = 0;
    for (const dir of dirs) {
      const t = board[`dd_${dir}_${key}`];
      if (t != null && t > maxTricks) maxTricks = t;
    }
    if (maxTricks < 7) continue;
    const maxLevel = maxTricks - 6;
    for (let level = 1; level <= maxLevel; level++) {
      const sc = computeScore(level, key === 'nt' ? 'NT' : key.toUpperCase(), maxTricks, vul, minor);
      if (sc > best) best = sc;
    }
  }
  return best;
}

function computeScore(level, denom, tricks, vul, isMinor) {
  const needed = level + 6;
  if (tricks < needed) return 0;
  const ot = tricks - needed;
  let ts, otv;
  if (isMinor) { ts = level * 20; otv = 20; }
  else if (denom === 'NT') { ts = 40 + (level - 1) * 30; otv = 30; }
  else { ts = level * 30; otv = 30; }

  const isGame = ts >= 100;
  let score = ts + ot * otv;
  if (level === 7) score += vul ? 1500 : 1000;
  else if (level === 6) score += vul ? 750 : 500;
  if (isGame) score += vul ? 500 : 300;
  else score += 50;
  return score;
}

function isVul(side, vulnerability) {
  if (vulnerability === 'both') return true;
  if (vulnerability === 'none') return false;
  return vulnerability === side;
}

function isSuboptimalTeam(open, closed, board, teamId) {
  // Check each room: did our pair play a suboptimal contract?
  for (const result of [open, closed]) {
    const ourSide = result.ns_participant_id === teamId ? 'ns' : 'ew';
    const vul = isVul(ourSide, board.vulnerability);
    const ddBest = bestDDScore(board, ourSide, vul);
    const actualScore = ourSide === 'ns' ? result.score : -result.score;
    if (ddBest > 0 && actualScore < ddBest) return true;
  }
  return false;
}

function isSuboptimalPair(result, board, pairId) {
  const ourSide = result.ns_participant_id === pairId ? 'ns' : 'ew';
  const vul = isVul(ourSide, board.vulnerability);
  const ddBest = bestDDScore(board, ourSide, vul);
  const actualScore = ourSide === 'ns' ? result.score : -result.score;
  return ddBest > 0 && actualScore < ddBest;
}
