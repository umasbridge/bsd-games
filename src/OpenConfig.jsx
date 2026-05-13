import { useState, useEffect } from 'react';
import { supabase as defaultSupabase } from './supabase.js';

export default function OpenConfig({ supabase: sbProp, userId, analysis, tournament: retrievedTournament, onBack, onProceed }) {
  const supabase = sbProp || defaultSupabase;
  const isNew = !analysis;

  const [tournament, setTournament] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [participants, setParticipants] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [selectedStageIds, setSelectedStageIds] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isNew && retrievedTournament) {
      initFromRetrieval(retrievedTournament);
    } else if (analysis) {
      initFromExisting(analysis);
    }
  }, []);

  const initFromRetrieval = (t) => {
    setTournament(t);
    setName(t.name);
    const allStageIds = new Set();
    for (const ev of t.bg_events || []) {
      for (const stg of ev.bg_stages || []) {
        allStageIds.add(stg.id);
      }
    }
    setSelectedStageIds(allStageIds);

    const primaryEvent = (t.bg_events || [])[0];
    if (primaryEvent) {
      loadParticipants(primaryEvent.id, [...allStageIds]);
    }
    setLoading(false);
  };

  const initFromExisting = async (a) => {
    const filters = a.filters || {};
    setName(a.name);
    setSelectedTeam(filters.participant_id || '');

    const existingStageIds = new Set(filters.stage_ids || (filters.stage_id ? [filters.stage_id] : []));
    setSelectedStageIds(existingStageIds);

    const tournamentId = a.bg_events?.bg_tournaments?.id;
    if (tournamentId) {
      const { data } = await supabase
        .from('bg_tournaments')
        .select(`
          id, name, location, date_start, source_format,
          bg_events ( id, name, type, scoring, event_order,
            bg_stages ( id, name, stage_order )
          )
        `)
        .eq('id', tournamentId)
        .single();

      if (data) {
        const sorted = {
          ...data,
          bg_events: (data.bg_events || [])
            .sort((a, b) => (a.event_order || 0) - (b.event_order || 0))
            .map(e => ({
              ...e,
              bg_stages: (e.bg_stages || []).sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0)),
            })),
        };
        setTournament(sorted);

        if (existingStageIds.size === 0) {
          const allIds = new Set();
          for (const ev of sorted.bg_events || []) {
            for (const stg of ev.bg_stages || []) allIds.add(stg.id);
          }
          setSelectedStageIds(allIds);
        }
      }
    }

    const eventId = a.bg_events?.id;
    if (eventId) {
      const stageIds = [...existingStageIds];
      await loadParticipants(eventId, stageIds.length > 0 ? stageIds : null);
    }
    setLoading(false);
  };

  const loadParticipants = async (eventId, stageIds) => {
    const { data: allParts } = await supabase
      .from('bg_participants')
      .select('id, number, name')
      .eq('event_id', eventId)
      .order('number');

    if (!stageIds?.length || !allParts?.length) {
      setParticipants(allParts || []);
      return;
    }

    const { data: results } = await supabase
      .from('bg_board_results')
      .select('ns_participant_id, ew_participant_id')
      .in('stage_id', stageIds);

    const activeIds = new Set();
    for (const r of (results || [])) {
      if (r.ns_participant_id) activeIds.add(r.ns_participant_id);
      if (r.ew_participant_id) activeIds.add(r.ew_participant_id);
    }

    const filtered = allParts.filter(p => activeIds.has(p.id));
    setParticipants(filtered.length > 0 ? filtered : allParts);
  };

  const getPrimaryEvent = () => {
    if (!tournament) return null;
    const events = tournament.bg_events || [];
    if (events.length === 1) return events[0];

    const eventCounts = {};
    for (const ev of events) {
      for (const stg of ev.bg_stages || []) {
        if (selectedStageIds.has(stg.id)) {
          eventCounts[ev.id] = (eventCounts[ev.id] || 0) + 1;
        }
      }
    }
    const sorted = Object.entries(eventCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return events[0];
    return events.find(e => e.id === sorted[0][0]) || events[0];
  };

  const primaryEvent = getPrimaryEvent();
  const isTeams = primaryEvent?.type === 'teams';

  const hasMultipleStages = tournament && (tournament.bg_events || []).reduce(
    (sum, ev) => sum + (ev.bg_stages || []).length, 0
  ) > 1;

  const handleStageToggle = (stageId) => {
    setSelectedStageIds(prev => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  };

  const handleProceed = async () => {
    if (selectedStageIds.size === 0) {
      setError('Select at least one stage.');
      return;
    }

    setSaving(true);
    setError('');

    const stageIds = [...selectedStageIds];
    const selections = [];
    for (const ev of (tournament?.bg_events || [])) {
      for (const stg of (ev.bg_stages || [])) {
        if (selectedStageIds.has(stg.id)) {
          selections.push({
            tournament_id: tournament.id, tournament_name: tournament.name,
            event_id: ev.id, event_name: ev.name,
            event_type: ev.type, event_scoring: ev.scoring,
            stage_id: stg.id, stage_name: stg.name,
          });
        }
      }
    }

    const team = selectedTeam ? participants.find(p => p.id === selectedTeam) : null;

    if (isNew) {
      const filters = {
        mode: 'custom',
        stage_ids: stageIds,
        selections,
        active_filters: [],
      };
      if (stageIds.length === 1) {
        const sel = selections[0];
        if (sel) {
          filters.stage_id = sel.stage_id;
          filters.stage_name = sel.stage_name;
        }
      }
      if (team) {
        filters.participant_id = team.id;
        filters.participant_name = team.name;
        if (!isTeams) filters.participant_number = team.number;
      }

      const { data, error: dbErr } = await supabase
        .from('bsd_game_analyses')
        .insert({
          user_id: userId,
          name: name.trim() || tournament.name,
          event_id: primaryEvent.id,
          participant_id: team?.id || null,
          filters,
        })
        .select(`
          id, name, filters, created_at, updated_at, user_id, participant_id,
          bg_events ( id, name, type, scoring,
            bg_tournaments ( id, name, date_start, location, source_format )
          )
        `)
        .single();

      setSaving(false);
      if (dbErr) { setError(dbErr.message); return; }
      onProceed(data);
    } else {
      const filters = { ...(analysis.filters || {}), stage_ids: stageIds, selections };
      if (stageIds.length === 1 && selections[0]) {
        filters.stage_id = selections[0].stage_id;
        filters.stage_name = selections[0].stage_name;
      }
      if (team) {
        filters.participant_id = team.id;
        filters.participant_name = team.name;
        if (!isTeams) filters.participant_number = team.number;
      } else {
        delete filters.participant_id;
        delete filters.participant_name;
        delete filters.participant_number;
      }

      const { data, error: dbErr } = await supabase
        .from('bsd_game_analyses')
        .update({
          name: name.trim() || analysis.name,
          participant_id: team?.id || null,
          filters,
        })
        .eq('id', analysis.id)
        .select(`
          id, name, filters, created_at, updated_at, user_id, participant_id,
          bg_events ( id, name, type, scoring,
            bg_tournaments ( id, name, date_start, location, source_format )
          )
        `)
        .single();

      setSaving(false);
      if (dbErr) { setError(dbErr.message); return; }
      onProceed(data);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={onBack} />
        <div className="px-6 py-8 text-center text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={onBack} />
      <div className="px-6 py-4 max-w-2xl">
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">

          {/* Deal set name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Deal Set Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </div>

          {/* Team / Pair selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isTeams ? 'Our Team' : 'Our Pair'}
            </label>
            <select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            >
              <option value="">{isTeams ? 'All teams' : 'All pairs'}</option>
              {participants.map(p => (
                <option key={p.id} value={p.id}>#{p.number} {p.name}</option>
              ))}
            </select>
          </div>

          {/* Stage selection (only if multiple stages) */}
          {hasMultipleStages && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Stages</label>
              <div className="space-y-1">
                {(tournament?.bg_events || []).map(ev => (
                  <div key={ev.id}>
                    {(tournament.bg_events.length > 1) && (
                      <p className="text-xs font-medium text-gray-500 mt-2 mb-1">
                        {ev.name} — {ev.type === 'teams' ? 'TEAMS' : 'PAIRS'} ({ev.scoring?.toUpperCase()})
                      </p>
                    )}
                    {(ev.bg_stages || []).map(stg => (
                      <label key={stg.id} className="flex items-center gap-2 py-1 px-2 hover:bg-blue-50 rounded cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedStageIds.has(stg.id)}
                          onChange={() => handleStageToggle(stg.id)}
                          className="rounded"
                        />
                        <span className="text-sm text-gray-700">{stg.name}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleProceed}
              disabled={saving || selectedStageIds.size === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Loading...' : 'View Deals'}
            </button>
            <button onClick={onBack} className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ onBack }) {
  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
      <button onClick={onBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
        &larr; Back
      </button>
      <h1 className="text-lg font-bold">Open Deal Set</h1>
    </div>
  );
}
