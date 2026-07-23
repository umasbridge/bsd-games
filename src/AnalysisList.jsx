import { useState, useEffect, useRef } from 'react';
import { supabase as defaultSupabase } from './supabase.js';
import { buildTeamRows, buildPairRows } from './AnalysisView.jsx';
import { downloadLin } from './linExport.js';

export default function AnalysisList({ supabase: sbProp, userId, userEmail, isAdmin, onNew, onRetrieve, onOpen, onCreateNew, onLogout, onBack, Header, displayRowsCache }) {
  const sb = sbProp || defaultSupabase;
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sharingAnalysis, setSharingAnalysis] = useState(null);
  const [downloading, setDownloading] = useState(null);

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

  const isOwner = (a) => a.user_id === userId;

  const handleBack = onBack || (() => { window.location.href = '/'; });

  return (
    <div className="min-h-screen bg-gray-100">
      {Header ? (
        <Header title="My Deal Sets" userEmail={userEmail} onLogout={onLogout} onBack={handleBack} />
      ) : (
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
              &larr; Dashboard
            </button>
            <h1 className="text-lg font-bold">My Deal Sets</h1>
          </div>
        </div>
      )}

      <div className="px-6 py-4 max-w-2xl">
        <div className="mb-4">
          <button
            onClick={onCreateNew}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Create New Deal Set
          </button>
        </div>
        {loading ? (
          <p className="text-gray-400 py-8 text-center">Loading...</p>
        ) : analyses.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400">
            No deal sets yet. Click "Create New Deal Set" to get started.
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
