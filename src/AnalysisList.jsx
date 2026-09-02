import { useState, useEffect, useRef } from 'react';
import { supabase as defaultSupabase } from './supabase.js';
import { buildTeamRows, buildPairRows } from './AnalysisView.jsx';
import { downloadLin, linHasPlay } from './linExport.js';

export default function AnalysisList({ supabase: sbProp, userId, userEmail, isAdmin, onNew, onRetrieve, onOpen, onCreateNew, onLogout, onBack, Header, ShareDialog, onPlay }) {
  const sb = sbProp || defaultSupabase;
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sharingAnalysis, setSharingAnalysis] = useState(null);
  const [downloading, setDownloading] = useState(null);
  const [pendingAnalysis, setPendingAnalysis] = useState(null);
  const [showSmartQuery, setShowSmartQuery] = useState(false);
  const [playableByAnalysis, setPlayableByAnalysis] = useState({});

  const analysisHasPlayableBoard = async (analysis) => {
    const filters = analysis.filters || {};
    let query = sb
      .from('bg_board_results')
      .select('lin')
      .not('lin', 'is', null)
      .ilike('lin', '%pc|%')
      .limit(1000);

    if (filters.board_ids?.length) {
      query = query.in('board_id', filters.board_ids);
    } else {
      let stageIds = filters.stage_ids || (filters.stage_id ? [filters.stage_id] : []);
      if (!stageIds.length && analysis.bg_events?.id) {
        const { data: stages } = await sb
          .from('bg_stages')
          .select('id')
          .eq('event_id', analysis.bg_events.id);
        stageIds = (stages || []).map(stage => stage.id);
      }
      if (!stageIds.length) return false;
      query = query.in('stage_id', stageIds);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Playability check failed:', analysis.id, error);
      return false;
    }
    return (data || []).some(result => linHasPlay(result.lin));
  };

  const fetchAnalyses = async () => {
    try {
      const { data, error } = await sb
        .from('bsd_game_analyses')
        .select(`
          id, name, filters, created_at, updated_at, user_id, participant_id,
          bg_events ( id, name, type, scoring,
            bg_tournaments ( id, name, date_start, location, source_format )
          )
        `)
        .order('updated_at', { ascending: false });
      if (error) console.error('Analyses fetch error:', error);
      const loaded = data || [];
      setAnalyses(loaded);
      const checks = await Promise.all(loaded.map(async analysis => [
        analysis.id,
        await analysisHasPlayableBoard(analysis),
      ]));
      setPlayableByAnalysis(Object.fromEntries(checks));
    } catch (e) {
      console.error('fetchAnalyses error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAnalyses(); }, []);

  const handleDelete = async (analysis) => {
    if (!confirm(`Delete "${analysis.name}"? This cannot be undone.`)) return;
    await sb.from('bsd_game_analyses').delete().eq('id', analysis.id);
    setAnalyses(prev => prev.filter(a => a.id !== analysis.id));
  };

  const isOwner = (a) => a.user_id === userId;

  const handleBack = onBack || (() => { window.location.href = '/'; });

  return (
    <div className="min-h-screen bg-gray-100">
      {Header ? (
        <Header title="My played deals" userEmail={userEmail} onLogout={onLogout} onBack={handleBack} />
      ) : (
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
              &larr; Dashboard
            </button>
            <h1 className="text-lg font-bold">My played deals</h1>
          </div>
          <button
            onClick={() => setShowSmartQuery(true)}
            className="px-3 py-1.5 border border-gray-300 rounded text-sm text-blue-700 hover:bg-blue-50"
          >
            Smart Query
          </button>
        </div>
      )}

      <div className="px-6 py-4 max-w-2xl">
        <div className="mb-4">
          <button
            onClick={onCreateNew}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Retrieve played hands
          </button>
        </div>
        {loading ? (
          <p className="text-gray-400 py-8 text-center">Loading...</p>
        ) : analyses.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
            No played deals yet. Click "Retrieve played hands" to get started.
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
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onOpen(a)}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                    >
                      View
                    </button>
                    {playableByAnalysis[a.id] && (
                      <button
                        onClick={() => setPendingAnalysis(a)}
                        className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                      >
                        Play
                      </button>
                    )}
                    {owner && (
                      <>
                        <button
                          onClick={() => setSharingAnalysis(a)}
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-blue-600 hover:bg-blue-50"
                        >
                          Share
                        </button>
                        <button
                          onClick={async () => {
                            setDownloading(a.id);
                            try { await downloadLin(sb, a); }
                            catch (e) { console.error('LIN download failed:', e); }
                            setDownloading(null);
                          }}
                          disabled={downloading === a.id}
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-blue-600 hover:bg-blue-50 disabled:text-gray-400"
                        >
                          {downloading === a.id ? '...' : 'LIN'}
                        </button>
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

      {pendingAnalysis && (
        <DirectionPickerDialog
          onPick={({ direction, cardingNS, cardingEW }) => {
            onPlay({ name: pendingAnalysis.name, analysis: pendingAnalysis, direction, cardingNS, cardingEW });
            setPendingAnalysis(null);
          }}
          onClose={() => setPendingAnalysis(null)}
        />
      )}

      {sharingAnalysis && (ShareDialog ? (
        <ShareDialog
          analysis={sharingAnalysis}
          supabase={sb}
          userId={userId}
          onClose={() => setSharingAnalysis(null)}
        />
      ) : (
        <ShareAnalysisDialog
          analysis={sharingAnalysis}
          supabase={sb}
          userId={userId}
          onClose={() => setSharingAnalysis(null)}
        />
      ))}

      {showSmartQuery && (
        <SmartQueryDialog
          supabase={sb}
          userId={userId}
          onClose={() => setShowSmartQuery(false)}
          onCreated={(newAnalysis) => {
            setAnalyses(prev => [newAnalysis, ...prev]);
            setShowSmartQuery(false);
          }}
        />
      )}
    </div>
  );
}


function DirectionPickerDialog({ onPick, onClose }) {
  const [sel, setSel] = useState(null);
  const [cns, setCns] = useState('UDCA');
  const [cew, setCew] = useState('UDCA');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-bold mb-3">Which direction would you like to play?</h2>
        <div className="flex gap-2 mb-4">
          {['N', 'S', 'E', 'W'].map(d => (
            <button
              key={d}
              onClick={() => setSel(d)}
              style={{
                minWidth: 44, padding: '4px 10px', borderRadius: 6, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer',
                border: sel === d ? '2px solid #2563eb' : '1px solid #d1d5db',
                background: sel === d ? '#2563eb' : '#fff',
                color: sel === d ? '#fff' : '#374151',
              }}
            >{d}</button>
          ))}
        </div>
        <div className="flex gap-4 mb-5 text-sm text-gray-500">
          <label className="flex flex-col gap-1">
            NS carding
            <select value={cns} onChange={e => setCns(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm">
              <option value="UDCA">UDCA</option>
              <option value="STD">Standard</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            EW carding
            <select value={cew} onChange={e => setCew(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm">
              <option value="UDCA">UDCA</option>
              <option value="STD">Standard</option>
            </select>
          </label>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            disabled={!sel}
            onClick={() => onPick({ direction: sel, cardingNS: cns, cardingEW: cew })}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-default"
          >
            Play →
          </button>
        </div>
      </div>
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


export function CreateDealSetPicker({ supabase: sbProp, userId, onBack, onRetrieve, onRetrieveBbo, onCreateFromSelection }) {
  const sb = sbProp || defaultSupabase;
  const [tournaments, setTournaments] = useState([]);
  const [loadingTournaments, setLoadingTournaments] = useState(true);
  const [expandedTournaments, setExpandedTournaments] = useState({});
  const [selectedStages, setSelectedStages] = useState([]);
  const [retrievingStage, setRetrievingStage] = useState(null);

  const selectedStageIds = new Set(selectedStages.map(s => s.stageId));

  useEffect(() => { loadTournaments(); }, []);

  const loadTournaments = async () => {
    // Personalized picker: only tournaments this user retrieved
    // (bg_tournament_visibility; retrieving an existing URL grants access)
    const { data } = await sb
      .from('bg_tournament_visibility')
      .select(`
        bg_tournaments (
          id, name, location, date_start, source_format, created_by, created_at,
          bg_events ( id, name, type, scoring, event_order,
            bg_stages ( id, name, stage_order, source_url, source_meta,
              bg_boards ( id )
            )
          )
        )
      `)
      .eq('user_id', userId);

    const visible = (data || []).map(r => r.bg_tournaments).filter(Boolean)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const sorted = visible.map(t => ({
      ...t,
      bg_events: (t.bg_events || [])
        .sort((a, b) => (a.event_order || 0) - (b.event_order || 0))
        .map(e => ({
          ...e,
          bg_stages: (e.bg_stages || []).sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0))
            .map(s => ({
              ...s,
              scraped: (s.bg_boards || []).length > 0,
              boardCount: (s.bg_boards || []).length,
              bg_boards: undefined,
            })),
        })),
    }));
    setTournaments(sorted);
    setLoadingTournaments(false);
  };

  const handleDeleteTournament = async (tourn) => {
    if (!confirm(`Delete "${tourn.name}" and all its data? This cannot be undone.`)) return;
    try {
      await fetch('/api/delete-tournament', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_id: tourn.id }),
      });
    } catch (e) {
      console.error('Delete failed:', e);
    }
    setSelectedStages(prev => prev.filter(s => s.tournamentId !== tourn.id));
    await loadTournaments();
  };

  const handleStageToggle = (ev, stg, tourn) => {
    setSelectedStages(prev => {
      const exists = prev.find(s => s.stageId === stg.id);
      if (exists) return prev.filter(s => s.stageId !== stg.id);
      return [...prev, {
        tournamentId: tourn.id, tournamentName: tourn.name,
        eventId: ev.id, eventName: ev.name, eventType: ev.type, eventScoring: ev.scoring,
        stageId: stg.id, stageName: stg.name,
        sourceFormat: tourn.source_format,
      }];
    });
  };

  const handleTournamentToggle = (tourn) => {
    const allStages = (tourn.bg_events || []).flatMap(ev =>
      (ev.bg_stages || []).map(stg => ({ ev, stg }))
    );
    const allChecked = allStages.every(({ stg }) => selectedStageIds.has(stg.id));
    setSelectedStages(prev => {
      if (allChecked) {
        const stageIds = new Set(allStages.map(({ stg }) => stg.id));
        return prev.filter(s => !stageIds.has(s.stageId));
      }
      const existing = new Set(prev.map(s => s.stageId));
      const toAdd = allStages.filter(({ stg }) => !existing.has(stg.id)).map(({ ev, stg }) => ({
        tournamentId: tourn.id, tournamentName: tourn.name,
        eventId: ev.id, eventName: ev.name, eventType: ev.type, eventScoring: ev.scoring,
        stageId: stg.id, stageName: stg.name,
        sourceFormat: tourn.source_format,
      }));
      return [...prev, ...toAdd];
    });
  };

  const handleRetrieveStage = async (stages) => {
    const list = Array.isArray(stages) ? stages : [stages];
    if (!list.length) return;
    setRetrievingStage(true);

    // Group stages by their scrape URL (BridgeWebs scraper discovers siblings automatically)
    // Use the first stage's URL to trigger scraping, pass all as mappings
    const firstUrl = list[0].source_url;
    const mappings = list.map(stg => {
      const eventId = tournaments.flatMap(t => t.bg_events || [])
        .find(ev => (ev.bg_stages || []).some(s => s.id === stg.id))?.id;
      return { stageId: stg.id, eventId, sourceUrl: stg.source_url };
    }).filter(m => m.eventId);

    try {
      await fetch('/api/scrape-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: firstUrl, mappings }),
      });
    } catch (e) {
      console.error('Retrieve failed:', e);
    }

    await loadTournaments();
    setRetrievingStage(null);
  };

  if (retrievingStage) {
    return (
      <div className="min-h-screen bg-gray-100">
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <h1 className="text-lg font-bold">Retrieving...</h1>
        </div>
        <div className="px-6 py-8 text-center">
          <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-3"></div>
          <p className="text-sm text-gray-600">Retrieving deals...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
            &larr; Back
          </button>
          <h1 className="text-lg font-bold">Create New Deal Set</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRetrieve}
            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            Retrieve New Tournament
          </button>
          <button
            onClick={onRetrieveBbo}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Retrieve BBO Hands
          </button>
        </div>
      </div>

      <div className="px-6 py-4 max-w-2xl space-y-4">
        {loadingTournaments ? (
          <p className="text-gray-400 py-8 text-center">Loading tournaments...</p>
        ) : tournaments.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
            No tournaments yet. Click "Retrieve New Tournament" to add one.
          </div>
        ) : (
          <TournamentPicker
            tournaments={tournaments}
            expandedTournaments={expandedTournaments}
            setExpandedTournaments={setExpandedTournaments}
            onStageToggle={handleStageToggle}
            onTournamentToggle={handleTournamentToggle}
            selectedStageIds={selectedStageIds}
            onRetrieveStage={handleRetrieveStage}
            onDelete={handleDeleteTournament}
          />
        )}

        {selectedStages.length > 0 && (
          <button
            onClick={() => onCreateFromSelection(selectedStages)}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}


function TournamentPicker({ tournaments, expandedTournaments, setExpandedTournaments, onStageToggle, onTournamentToggle, selectedStageIds, onRetrieveStage, onDelete }) {
  const groups = { teams: [], pairs: [] };
  for (const t of tournaments) {
    const teamsEvents = (t.bg_events || []).filter(e => e.type === 'teams');
    const pairsEvents = (t.bg_events || []).filter(e => e.type !== 'teams');
    if (teamsEvents.length) groups.teams.push({ ...t, bg_events: teamsEvents });
    if (pairsEvents.length) groups.pairs.push({ ...t, bg_events: pairsEvents });
  }

  const sections = [
    { key: 'teams', label: 'Teams', data: groups.teams },
    { key: 'pairs', label: 'Pairs', data: groups.pairs },
  ].filter(s => s.data.length > 0);

  return (
    <div className="space-y-4">
      {sections.map(section => (
        <div key={section.key}>
          <label className="block text-sm font-bold text-gray-700 mb-2">{section.label}</label>
          <div className="space-y-1">
            {section.data.map(t => (
              <TournamentRow
                key={`${section.key}-${t.id}`}
                tournament={t}
                expanded={!!expandedTournaments[`${section.key}-${t.id}`]}
                onToggle={() => setExpandedTournaments(prev => ({ ...prev, [`${section.key}-${t.id}`]: !prev[`${section.key}-${t.id}`] }))}
                onStageToggle={(ev, stg) => onStageToggle(ev, stg, t)}
                onTournamentToggle={() => onTournamentToggle(t)}
                selectedStageIds={selectedStageIds}
                onRetrieveStage={onRetrieveStage}
                onDelete={() => onDelete(t)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}


function TournamentRow({ tournament, expanded, onToggle, onStageToggle, onTournamentToggle, selectedStageIds, onRetrieveStage, onDelete }) {
  const t = tournament;
  const events = t.bg_events || [];
  const allStages = events.flatMap(ev => (ev.bg_stages || []).map(stg => ({ ev, stg })));
  const scrapedStages = allStages.filter(({ stg }) => stg.scraped);
  const totalBoards = scrapedStages.reduce((sum, { stg }) => sum + (stg.boardCount || 0), 0);
  const hasMultipleStages = allStages.length > 1;
  const allChecked = allStages.length > 0 && allStages.every(({ stg }) => selectedStageIds.has(stg.id));
  const someChecked = allStages.some(({ stg }) => selectedStageIds.has(stg.id)) && !allChecked;

  if (!hasMultipleStages) {
    const single = allStages[0];
    if (!single) return null;
    return (
      <div className="flex items-center px-4 py-3 border border-gray-200 rounded-lg bg-white hover:bg-blue-50">
        <label className="flex items-center flex-1 cursor-pointer">
          <input
            type="checkbox"
            checked={selectedStageIds.has(single.stg.id)}
            onChange={() => single.stg.scraped && onStageToggle(single.ev, single.stg)}
            disabled={!single.stg.scraped}
            className="rounded mr-3"
          />
          <span className="text-base font-bold text-gray-800 flex-1">{t.name}</span>
          {single.stg.scraped && <span className="text-xs text-gray-400">{single.stg.boardCount} boards</span>}
        </label>
        <button onClick={onDelete} className="ml-2 text-xs text-red-400 hover:text-red-600">Delete</button>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="flex items-center px-4 py-3 bg-gray-50 hover:bg-gray-100">
        <input
          type="checkbox"
          checked={allChecked}
          ref={el => { if (el) el.indeterminate = someChecked; }}
          onChange={onTournamentToggle}
          className="rounded mr-3 flex-shrink-0"
        />
        <button onClick={onToggle} className="flex-1 text-left flex items-center">
          <span className="text-gray-400 text-xs mr-2">{expanded ? '▾' : '▸'}</span>
          <span className="text-base font-bold text-gray-800 flex-1">{t.name}</span>
        </button>
        <span className="text-xs text-gray-400 mr-2">{totalBoards} boards</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-xs text-red-400 hover:text-red-600">Delete</button>
      </div>

      {expanded && allStages.map(({ ev, stg }) => (
        <label
          key={stg.id}
          className={`flex items-center pl-10 pr-4 py-2 border-t border-gray-100 ${stg.scraped ? 'hover:bg-blue-50 cursor-pointer' : 'opacity-50'}`}
        >
          <input
            type="checkbox"
            checked={selectedStageIds.has(stg.id)}
            onChange={() => stg.scraped && onStageToggle(ev, stg)}
            disabled={!stg.scraped}
            className="rounded mr-3"
          />
          <span className="text-sm text-gray-700 flex-1">
            {events.length > 1 ? `${ev.name} — ${stg.name}` : stg.name}
          </span>
          {stg.scraped && <span className="text-xs text-gray-400">{stg.boardCount} boards</span>}
        </label>
      ))}
    </div>
  );
}


const IMP_TABLE = [
  [0,10,0],[20,40,1],[50,80,2],[90,120,3],[130,160,4],[170,210,5],
  [220,260,6],[270,310,7],[320,360,8],[370,420,9],[430,490,10],
  [500,590,11],[600,740,12],[750,890,13],[900,1090,14],[1100,1290,15],
  [1300,1490,16],[1500,1740,17],[1750,1990,18],[2000,2240,19],
  [2250,2490,20],[2500,2990,21],[3000,3490,22],[3500,3990,23],[4000,Infinity,24],
];

function scoreToImpsAbs(netScore) {
  const abs = Math.abs(netScore);
  for (const [lo, hi, imp] of IMP_TABLE) {
    if (abs >= lo && abs <= hi) return imp;
  }
  return 24;
}


function SmartQueryDialog({ supabase, userId, onClose, onCreated }) {
  const [phase, setPhase] = useState('idle'); // idle | searching | done | creating | error
  const [matchedBoardIds, setMatchedBoardIds] = useState([]);
  const [matchedEventIds, setMatchedEventIds] = useState([]);
  const [primaryEventId, setPrimaryEventId] = useState(null);
  const [name, setName] = useState('Teams: 6+ IMP swing at game level');
  const [error, setError] = useState('');

  const handleSearch = async () => {
    setPhase('searching');
    setError('');
    try {
      // Visible tournaments for this user
      const { data: vis } = await supabase
        .from('bg_tournament_visibility')
        .select('tournament_id')
        .eq('user_id', userId);
      const tournamentIds = (vis || []).map(v => v.tournament_id);
      if (!tournamentIds.length) { setMatchedBoardIds([]); setPhase('done'); return; }

      // Teams events in those tournaments
      const { data: eventsData } = await supabase
        .from('bg_events')
        .select('id')
        .in('tournament_id', tournamentIds)
        .eq('type', 'teams');
      const eventIds = (eventsData || []).map(e => e.id);
      if (!eventIds.length) { setMatchedBoardIds([]); setPhase('done'); return; }

      // Stages for those events
      const { data: stagesData } = await supabase
        .from('bg_stages')
        .select('id, event_id')
        .in('event_id', eventIds);
      const stageIds = (stagesData || []).map(s => s.id);
      const stageEventMap = {};
      for (const s of (stagesData || [])) stageEventMap[s.id] = s.event_id;
      if (!stageIds.length) { setMatchedBoardIds([]); setPhase('done'); return; }

      // Board results: has bidding (lin contains mb|), game-level contract, part of a match
      const allResults = [];
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from('bg_board_results')
          .select('board_id, stage_id, room, match_id, round, contract_level, imps_ns, score')
          .in('stage_id', stageIds)
          .like('lin', '%mb|%')
          .gte('contract_level', 4)
          .not('match_id', 'is', null)
          .order('id')
          .range(from, from + 999);
        if (!data?.length) break;
        allResults.push(...data);
        if (data.length < 1000) break;
        from += 1000;
      }

      // Group into open+closed pairs by board_id + match_id
      const pairs = {};
      for (const r of allResults) {
        const key = `${r.board_id}__${r.match_id}__${r.round ?? ''}`;
        if (!pairs[key]) pairs[key] = {};
        if (r.room === 'open') pairs[key].open = r;
        else if (r.room === 'closed') pairs[key].closed = r;
      }

      // Filter: both rooms present + IMP swing >= 6
      const qualifyingBoardIds = new Set();
      const qualifyingEventIds = new Set();
      const eventHits = {};

      for (const { open, closed } of Object.values(pairs)) {
        if (!open || !closed) continue;

        // IMP swing: stored imps_ns preferred, fall back to score-based
        const maxImpNs = Math.max(Math.abs(open.imps_ns || 0), Math.abs(closed.imps_ns || 0));
        const swing = maxImpNs > 0
          ? maxImpNs
          : scoreToImpsAbs(Math.abs((open.score || 0) + (closed.score || 0)));

        if (swing >= 6) {
          qualifyingBoardIds.add(open.board_id);
          const evtId = stageEventMap[open.stage_id];
          if (evtId) {
            qualifyingEventIds.add(evtId);
            eventHits[evtId] = (eventHits[evtId] || 0) + 1;
          }
        }
      }

      const boardIds = [...qualifyingBoardIds];
      const evtIdsList = [...qualifyingEventIds];
      setMatchedBoardIds(boardIds);
      setMatchedEventIds(evtIdsList);

      const primaryEvt = Object.entries(eventHits).sort((a, b) => b[1] - a[1])[0]?.[0] || evtIdsList[0] || null;
      setPrimaryEventId(primaryEvt);
      setPhase('done');
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !primaryEventId) return;
    setPhase('creating');
    setError('');

    const filters = {
      mode: 'board_ids',
      board_ids: matchedBoardIds,
      event_ids: matchedEventIds,
      query_label: 'Teams · 6+ IMP swing · game level · bidding',
    };

    const { data, error: dbErr } = await supabase
      .from('bsd_game_analyses')
      .insert({ user_id: userId, name: name.trim(), event_id: primaryEventId, filters })
      .select(`
        id, name, filters, created_at, updated_at, user_id, participant_id,
        bg_events ( id, name, type, scoring,
          bg_tournaments ( id, name, date_start, location, source_format )
        )
      `)
      .single();

    if (dbErr) { setError(dbErr.message); setPhase('done'); return; }
    onCreated(data);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-bold mb-1">Smart Query — Teams Bidding Boards</h2>
        <p className="text-sm text-gray-500 mb-4">
          Find boards from your teams events where bidding is recorded, the IMP swing is ≥ 6, and both tables reached game (4-level or higher).
        </p>

        {phase === 'idle' && (
          <button onClick={handleSearch} className="w-full px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
            Search
          </button>
        )}

        {phase === 'searching' && (
          <div className="text-center py-4">
            <div className="inline-block animate-spin w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full mb-2" />
            <p className="text-sm text-gray-500">Searching across your teams events...</p>
          </div>
        )}

        {(phase === 'done' || phase === 'creating') && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded px-3 py-2 text-sm text-gray-700">
              {matchedBoardIds.length === 0
                ? 'No boards found matching these criteria in your library.'
                : <><span className="font-bold">{matchedBoardIds.length}</span> boards found</>
              }
            </div>
            {matchedBoardIds.length > 0 && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deal Set Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                    autoFocus
                  />
                </div>
                {error && <p className="text-red-500 text-xs">{error}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleCreate}
                    disabled={phase === 'creating' || !name.trim()}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {phase === 'creating' ? 'Creating...' : 'Create Deal Set'}
                  </button>
                  <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
                    Cancel
                  </button>
                </div>
              </>
            )}
            {matchedBoardIds.length === 0 && (
              <button onClick={onClose} className="w-full px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
                Close
              </button>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <p className="text-red-500 text-sm">{error}</p>
            <div className="flex gap-2">
              <button onClick={handleSearch} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">Retry</button>
              <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded text-sm">Cancel</button>
            </div>
          </div>
        )}
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
