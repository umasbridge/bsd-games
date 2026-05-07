import { useState, useEffect } from 'react';
import { supabase as defaultSupabase } from './supabase.js';
import { buildTeamRows, buildPairRows } from './AnalysisView.jsx';

export default function AnalysisList({ supabase: sbProp, userId, userEmail, isAdmin, onNew, onOpen, onLogout, onBack, Header, displayRowsCache }) {
  const sb = sbProp || defaultSupabase;
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(null);
  const [sharingAnalysis, setSharingAnalysis] = useState(null);

  const fetchAnalyses = async () => {
    const { data: { session } } = await sb.auth.getSession();
    console.log('Auth session:', session?.user?.id, session?.user?.email);

    const { data, error } = await sb
      .from('bsd_game_analyses')
      .select(`
        id, name, filters, created_at, updated_at, user_id, participant_id,
        bg_events ( id, name, type, scoring,
          bg_tournaments ( id, name, date_start, location, source_format )
        )
      `)
      .order('updated_at', { ascending: false });
    console.log('Analyses fetched:', data?.length, 'error:', error);
    setAnalyses(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchAnalyses(); }, []);

  const handleDelete = async (analysis) => {
    if (!confirm(`Delete "${analysis.name}"? This cannot be undone.`)) return;
    await sb.from('bsd_game_analyses').delete().eq('id', analysis.id);
    setAnalyses(prev => prev.filter(a => a.id !== analysis.id));
  };

  const DEALER_TO_LIN = { N: '3', E: '4', S: '1', W: '2' };
  const VUL_TO_LIN = { none: 'o', ns: 'n', ew: 'e', both: 'b' };
  const SUIT_ORDER = ['S', 'H', 'D', 'C'];
  const DIR_ORDER = ['S', 'W', 'N', 'E'];

  const buildMd = (board) => {
    const dealer = board.dealer || 'N';
    const dealerNum = DEALER_TO_LIN[dealer] || '3';
    // BBO md| always lists hands in S,W,N,E order
    const hands = ['s', 'w', 'n', 'e'].map(d =>
      SUIT_ORDER.map(s => {
        const key = `${d}_${s === 'S' ? 'spades' : s === 'H' ? 'hearts' : s === 'D' ? 'diamonds' : 'clubs'}`;
        return s + (board[key] || '');
      }).join('')
    );
    return `md|${dealerNum}${hands.join(',')}`;
  };

  const patchLin = (lin, board, result) => {
    const md = buildMd(board);
    const sv = `sv|${VUL_TO_LIN[board.vulnerability] || 'o'}`;
    // Fix pn| to BBO order: S,W,N,E
    const pn = `pn|${result?.player_s_name || ''},${result?.player_w_name || ''},${result?.player_n_name || ''},${result?.player_e_name || ''}`;
    let patched = lin.replace(/md\|[^|]*/, md).replace(/sv\|[^|]*/, sv);
    if (result?.player_n_name) patched = patched.replace(/pn\|[^|]*/, pn);
    return patched;
  };

  const buildLinFromRows = (rows, analysisName) => {
    const lines = [];
    rows.forEach((row, i) => {
      if (!row.board || !row.result?.lin) return;
      const bn = row.board.board_number;
      const roomTag = row.result.room === 'open' ? 'o' : row.result.room === 'closed' ? 'c' : '';
      lines.push(`qx|${roomTag}${bn}|ah|Board ${bn}|${patchLin(row.result.lin, row.board, row.result)}`);
      if (row.otherRoom?.lin) {
        const otherTag = row.otherRoom.room === 'open' ? 'o' : row.otherRoom.room === 'closed' ? 'c' : '';
        lines.push(`qx|${otherTag}${bn}|ah|Board ${bn}|${patchLin(row.otherRoom.lin, row.board, row.otherRoom)}`);
      }
    });
    if (!lines.length) return;
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analysisName.replace(/[^a-zA-Z0-9_-]/g, '_')}.lin`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadLin = async (analysis) => {
    // Use cached displayRows if available (exact match with viewer)
    const cached = displayRowsCache?.[analysis.id];
    if (cached) {
      buildLinFromRows(cached, analysis.name);
      return;
    }

    // Fallback: fetch and compute (user hasn't viewed this analysis yet)
    setDownloading(analysis.id);
    try {
      const filters = analysis.filters || {};
      const event = analysis.bg_events;
      const eventId = event?.id;
      const isTeams = event?.type === 'teams';

      let stageIds;
      if (filters.stage_ids?.length) {
        stageIds = filters.stage_ids;
      } else if (filters.stage_id) {
        stageIds = [filters.stage_id];
      } else if (eventId) {
        const { data: stages } = await sb.from('bg_stages').select('id').eq('event_id', eventId);
        stageIds = (stages || []).map(s => s.id);
      }
      if (!stageIds?.length) { setDownloading(null); return; }

      const eventIds = filters.selections?.length
        ? [...new Set(filters.selections.map(s => s.event_id))]
        : [eventId];
      const participantQuery = eventIds.length === 1
        ? sb.from('bg_participants').select('id, number, name, roster').eq('event_id', eventIds[0])
        : sb.from('bg_participants').select('id, number, name, roster').in('event_id', eventIds);

      const [{ data: boards }, { data: results }, { data: participants }] = await Promise.all([
        sb.from('bg_boards').select('*').in('stage_id', stageIds).order('board_number'),
        sb.from('bg_board_results').select('*').in('stage_id', stageIds).order('id'),
        participantQuery,
      ]);

      const participantMap = {};
      for (const p of (participants || [])) participantMap[p.id] = p;

      const rows = isTeams
        ? buildTeamRows(boards || [], results || [], filters, participantMap)
        : buildPairRows(boards || [], results || [], filters);

      buildLinFromRows(rows, analysis.name);
    } catch (e) {
      console.error('LIN download failed:', e);
    }
    setDownloading(null);
  };

  const isOwner = (a) => a.user_id === userId;

  const handleBack = onBack || (() => { window.location.href = '/'; });

  return (
    <div className="min-h-screen bg-gray-100">
      {Header ? (
        <Header title="My Games" userEmail={userEmail} onLogout={onLogout} onBack={handleBack} />
      ) : (
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
              &larr; Dashboard
            </button>
            <h1 className="text-lg font-bold">My Games</h1>
          </div>
        </div>
      )}

      <div className="px-6 py-4">
        <div className="flex gap-3 items-center mb-4">
          <button
            onClick={onNew}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Analyse New Game
          </button>
        </div>

        {loading ? (
          <p className="text-gray-400 py-8 text-center">Loading...</p>
        ) : analyses.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
            No game analyses yet. Click "Analyse New Game" to get started.
          </div>
        ) : (
          <div className="space-y-2">
            {analyses.map((a) => {
              const ev = a.bg_events;
              const t = ev?.bg_tournaments;
              const filters = a.filters || {};
              const filterDesc = buildFilterDescription(filters, ev?.type);
              const owner = isOwner(a);

              return (
                <div
                  key={a.id}
                  className="bg-white rounded-lg px-4 py-3 border border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                >
                  <div>
                    <p className="font-medium text-gray-800">{a.name}</p>
                    <p className="text-sm text-gray-500">
                      {[t?.name, ev?.name, t?.date_start, filterDesc].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onOpen(a)}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                    >
                      Open
                    </button>
                    {owner && (
                      <>
                        <button
                          onClick={() => setSharingAnalysis(a)}
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-blue-600 hover:bg-blue-50"
                        >
                          Share
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => handleDownloadLin(a)}
                            disabled={downloading === a.id}
                            className="px-3 py-1 border border-gray-200 rounded text-sm text-blue-600 hover:bg-blue-50 disabled:text-gray-400"
                            title="Download LIN"
                          >
                            {downloading === a.id ? '...' : 'LIN'}
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(a)}
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sharingAnalysis && (
        <ShareAnalysisDialog
          analysis={sharingAnalysis}
          supabase={sb}
          userId={userId}
          onClose={() => setSharingAnalysis(null)}
        />
      )}
    </div>
  );
}


function ShareAnalysisDialog({ analysis, supabase, userId, onClose }) {
  const [email, setEmail] = useState('');
  const [shares, setShares] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const shared = analysis.filters?.shared_with || [];
    setShares(shared);
  }, [analysis.id]);

  const handleShare = async () => {
    setError('');
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setLoading(true);
    try {
      const { data: targetUserId, error: lookupErr } = await supabase
        .rpc('lookup_user_by_email', { lookup_email: trimmed });

      if (lookupErr || !targetUserId) {
        setError('No user found with that email.');
        setLoading(false);
        return;
      }

      if (targetUserId === userId) {
        setError("You can't share with yourself.");
        setLoading(false);
        return;
      }

      const existing = analysis.filters?.shared_with || [];
      if (existing.some(s => s.userId === targetUserId)) {
        setError('Already shared with this user.');
        setLoading(false);
        return;
      }

      const updated = [...existing, { userId: targetUserId, email: trimmed }];
      const newFilters = { ...analysis.filters, shared_with: updated };

      await supabase
        .from('bsd_game_analyses')
        .update({ filters: newFilters })
        .eq('id', analysis.id);

      // Add user to all existing discussions for this analysis
      const { data: discussions } = await supabase
        .from('discussions')
        .select('id')
        .eq('resource_type', 'game_board')
        .like('resource_id', `${analysis.id}:%`);

      if (discussions?.length) {
        const memberInserts = discussions.map(d => ({
          discussion_id: d.id,
          user_id: targetUserId,
        }));
        await supabase.from('discussion_members').upsert(memberInserts, {
          onConflict: 'discussion_id,user_id',
        });
      }

      setShares(updated);
      setEmail('');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (targetUserId) => {
    const updated = shares.filter(s => s.userId !== targetUserId);
    const newFilters = { ...analysis.filters, shared_with: updated };
    await supabase
      .from('bsd_game_analyses')
      .update({ filters: newFilters })
      .eq('id', analysis.id);

    // Remove from discussions
    const { data: discussions } = await supabase
      .from('discussions')
      .select('id')
      .eq('resource_type', 'game_board')
      .like('resource_id', `${analysis.id}:%`);

    if (discussions?.length) {
      for (const d of discussions) {
        await supabase.from('discussion_members').delete()
          .eq('discussion_id', d.id).eq('user_id', targetUserId);
      }
    }

    setShares(updated);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-1">Share "{analysis.name}"</h2>
        <p className="text-xs text-gray-400 mb-4">Add people by email address</p>

        <div className="flex gap-2 mb-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
            onKeyDown={(e) => e.key === 'Enter' && handleShare()}
            autoFocus
          />
          <button
            onClick={handleShare}
            disabled={loading || !email.trim()}
            className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Share
          </button>
        </div>

        {error && <p className="text-red-500 text-xs mb-3">{error}</p>}

        {shares.length > 0 && (
          <div className="border-t border-gray-200 mt-3 pt-3">
            <p className="text-xs text-gray-500 mb-2">Shared with</p>
            <div className="space-y-2">
              {shares.map((share) => (
                <div key={share.userId} className="flex items-center justify-between text-sm">
                  <span className="text-gray-700">{share.email}</span>
                  <button
                    onClick={() => handleRemove(share.userId)}
                    className="text-red-500 text-xs hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}


function buildFilterDescription(filters, type) {
  const parts = [];
  if (filters.participant_name) parts.push(filters.participant_name);
  if (filters.stage_ids?.length > 1) {
    parts.push(`${filters.stage_ids.length} stages`);
  } else if (filters.stage_name) {
    parts.push(filters.stage_name);
  }
  if (filters.mode === 'diff_contract') parts.push('Different contracts');
  if (filters.mode === 'diff_tricks') parts.push('Same contract, diff tricks');
  if (filters.board_start || filters.board_end) {
    parts.push(`Boards ${filters.board_start || '1'}–${filters.board_end || 'end'}`);
  }
  return parts.join(', ');
}
