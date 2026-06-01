import { useState, useEffect, useRef } from 'react';
import { supabase as defaultSupabase } from './supabase.js';

export default function NewAnalysis({ supabase: sbProp, userId, onBack, onCreated }) {
  const supabase = sbProp || defaultSupabase;
  const [step, setStep] = useState('pick'); // pick | filters
  const [tournaments, setTournaments] = useState([]);
  const [loadingTournaments, setLoadingTournaments] = useState(true);
  const [expandedTournaments, setExpandedTournaments] = useState({});

  const [error, setError] = useState('');

  // Multi-stage selection: [{tournamentId, tournamentName, eventId, eventName, eventType, eventScoring, stageId, stageName, sourceFormat}]
  const [selectedStages, setSelectedStages] = useState([]);

  // Derived from selection (set when proceeding to filters)
  const [event, setEvent] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [participants, setParticipants] = useState([]);

  // Filters
  const [name, setName] = useState('');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [searchText, setSearchText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);
  const [selectedFilters, setSelectedFilters] = useState([]);
  const [impThreshold, setImpThreshold] = useState('5');
  const [pctThreshold, setPctThreshold] = useState('40');
  const [saving, setSaving] = useState(false);

  const isTeams = event?.type === 'teams';

  useEffect(() => { loadTournaments(); }, []);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadTournaments = async () => {
    const { data } = await supabase
      .from('bg_tournaments')
      .select(`
        id, name, location, date_start, source_format,
        bg_events ( id, name, type, scoring, event_order,
          bg_stages ( id, name, stage_order )
        )
      `)
      .order('created_at', { ascending: false });

    const sorted = (data || []).map(t => ({
      ...t,
      bg_events: (t.bg_events || [])
        .sort((a, b) => (a.event_order || 0) - (b.event_order || 0))
        .map(e => ({
          ...e,
          bg_stages: (e.bg_stages || []).sort((a, b) => (a.stage_order || 0) - (b.stage_order || 0)),
        })),
    }));
    setTournaments(sorted);
    setLoadingTournaments(false);
  };

  const selectedStageIds = new Set(selectedStages.map(s => s.stageId));

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

  const handleEventToggle = (ev, tourn) => {
    const stages = ev.bg_stages || [];
    const allChecked = stages.every(s => selectedStageIds.has(s.id));
    setSelectedStages(prev => {
      if (allChecked) {
        const stageIds = new Set(stages.map(s => s.id));
        return prev.filter(s => !stageIds.has(s.stageId));
      }
      const existing = new Set(prev.map(s => s.stageId));
      const toAdd = stages.filter(s => !existing.has(s.id)).map(stg => ({
        tournamentId: tourn.id, tournamentName: tourn.name,
        eventId: ev.id, eventName: ev.name, eventType: ev.type, eventScoring: ev.scoring,
        stageId: stg.id, stageName: stg.name,
        sourceFormat: tourn.source_format,
      }));
      return [...prev, ...toAdd];
    });
  };

  const proceedToFilters = async () => {
    if (!selectedStages.length) return;

    const eventCounts = {};
    for (const s of selectedStages) eventCounts[s.eventId] = (eventCounts[s.eventId] || 0) + 1;
    const primaryEventId = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])[0][0];
    const primary = selectedStages.find(s => s.eventId === primaryEventId);

    setEvent({ id: primaryEventId, name: primary.eventName, type: primary.eventType, scoring: primary.eventScoring });
    setTournament({ id: primary.tournamentId, name: primary.tournamentName, source_format: primary.sourceFormat });

    if (selectedStages.length === 1) {
      const s = selectedStages[0];
      setName(`${s.tournamentName} - ${s.eventName} - ${s.stageName}`);
    } else {
      const uniqueTournaments = [...new Set(selectedStages.map(s => s.tournamentName))];
      const uniqueEvents = [...new Set(selectedStages.map(s => s.eventName))];
      const label = uniqueTournaments.length === 1
        ? `${uniqueTournaments[0]} - ${uniqueEvents.join(', ')}`
        : uniqueTournaments.join(', ');
      setName(label);
    }

    const stageIdsForPrimary = selectedStages.filter(s => s.eventId === primaryEventId).map(s => s.stageId);
    await loadParticipants(primaryEventId, stageIdsForPrimary);
    setStep('filters');
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

  const toggleFilter = (f) => {
    setSelectedFilters(prev =>
      prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Give your deal set a name.'); return; }

    setSaving(true);
    setError('');

    const filters = { mode: 'custom', active_filters: selectedFilters };

    filters.stage_ids = selectedStages.map(s => s.stageId);
    filters.selections = selectedStages.map(s => ({
      tournament_id: s.tournamentId, tournament_name: s.tournamentName,
      event_id: s.eventId, event_name: s.eventName,
      event_type: s.eventType, event_scoring: s.eventScoring,
      stage_id: s.stageId, stage_name: s.stageName,
    }));

    if (selectedStages.length === 1) {
      filters.stage_id = selectedStages[0].stageId;
      filters.stage_name = selectedStages[0].stageName;
    }

    if (selectedTeam) {
      const team = participants.find(p => p.id === selectedTeam);
      filters.participant_id = selectedTeam;
      filters.participant_name = team?.name || '';
      if (!isTeams) filters.participant_number = team?.number;
    }
    if (selectedFilters.includes('imp_loss')) {
      filters.imp_threshold = parseInt(impThreshold) || 5;
    }
    if (selectedFilters.includes('low_pct')) {
      filters.pct_threshold = parseInt(pctThreshold) || 40;
    }

    const participantId = selectedTeam || null;

    let data, dbErr;
    try {
      const result = await supabase
        .from('bsd_game_analyses')
        .insert({
          user_id: userId,
          name: name.trim(),
          event_id: event.id,
          participant_id: participantId,
          filters,
        })
        .select(`
          id, name, filters, created_at, updated_at, user_id, participant_id,
          bg_events ( id, name, type, scoring,
            bg_tournaments ( id, name, date_start, location, source_format )
          )
        `)
        .single();
      data = result.data;
      dbErr = result.error;
    } catch (e) {
      setSaving(false);
      setError(`${e.name}: ${e.message}`);
      console.error('Create analysis error:', e);
      console.log('Insert payload:', { user_id: userId, event_id: event.id, participant_id: participantId, name: name.trim() });
      return;
    }

    setSaving(false);

    if (dbErr) {
      setError(dbErr.message);
      return;
    }

    onCreated(data);
  };

  // ── Pick step ──────────────────────────────────────────────────

  if (step === 'pick') {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={onBack} title="Create Deal Set" />
        <div className="px-6 py-4 max-w-2xl space-y-4">

          {error && (
            <p className="text-sm text-red-600 bg-white border border-red-200 rounded-lg p-3">{error}</p>
          )}

          {/* Tournament list */}
          {loadingTournaments ? (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-gray-400 text-sm py-4 text-center">Loading...</p>
            </div>
          ) : tournaments.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-gray-400 text-sm py-4 text-center">
                No tournaments yet. Use "Retrieve Played Deals" to add one.
              </p>
            </div>
          ) : (
            <TypeGroupedList
              tournaments={tournaments}
              expandedTournaments={expandedTournaments}
              setExpandedTournaments={setExpandedTournaments}
              onStageToggle={handleStageToggle}
              onEventToggle={handleEventToggle}
              onTournamentToggle={handleTournamentToggle}
              selectedStageIds={selectedStageIds}
            />
          )}

          {/* Next button */}
          {selectedStages.length > 0 && (
            <div className="sticky bottom-4">
              <button
                onClick={proceedToFilters}
                className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-lg"
              >
                Next — {selectedStages.length} stage{selectedStages.length !== 1 ? 's' : ''} selected
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Filters step ───────────────────────────────────────────────

  const hasBidding = selectedStages.some(s => s.sourceFormat === 'lovebridge');

  const teamFilters = [
    { key: 'diff_contract', label: 'Deals where the 2 tables were in different contracts' },
    { key: 'same_contract_down', label: 'Both sides same contract, one went down' },
    { key: 'game_both_tables', label: 'Final contract 4-level or higher at both tables' },
    { key: 'defender_bid_high', label: 'Defending side bid 3+ level at one or both tables', needsBidding: true },
    { key: 'imp_loss', label: `Deals where exchange of more than  IMPs`, hasInput: true, inputValue: impThreshold, onInput: setImpThreshold, inputPlaceholder: '5' },
    { key: 'suboptimal', label: 'Deals where we were in a suboptimal contract' },
  ];

  const pairFilters = [
    { key: 'low_pct', label: `Deals with score below %`, hasInput: true, inputValue: pctThreshold, onInput: setPctThreshold, inputPlaceholder: '40' },
    { key: 'suboptimal', label: 'Deals where we were in a suboptimal contract' },
  ];

  const availableFilters = isTeams ? teamFilters : pairFilters;

  // Group selections for display
  const selectionsByTournament = {};
  for (const s of selectedStages) {
    if (!selectionsByTournament[s.tournamentId]) {
      selectionsByTournament[s.tournamentId] = { name: s.tournamentName, events: {} };
    }
    const t = selectionsByTournament[s.tournamentId];
    if (!t.events[s.eventId]) {
      t.events[s.eventId] = { name: s.eventName, type: s.eventType, scoring: s.eventScoring, stages: [] };
    }
    t.events[s.eventId].stages.push(s.stageName);
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={() => setStep('pick')} title="Create Deal Set" />
      <div className="px-6 py-4 max-w-2xl">
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          {/* Selection summary */}
          <div className="bg-gray-50 rounded px-3 py-2 text-sm space-y-1">
            {Object.values(selectionsByTournament).map((t, i) => (
              <div key={i}>
                <span className="font-medium">{t.name}</span>
                {Object.values(t.events).map((ev, j) => (
                  <div key={j} className="text-gray-600 ml-3">
                    {ev.name} – {ev.type === 'teams' ? 'TEAMS' : 'PAIRS'} ({ev.scoring?.toUpperCase()})
                    <span className="font-medium text-gray-700 ml-1">· {ev.stages.join(', ')}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

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
          <div className="relative" ref={dropdownRef}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isTeams ? 'Our Team' : 'Our Pair'}
            </label>
            <input
              type="text"
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); setShowDropdown(true); setSelectedTeam(''); }}
              onFocus={() => setShowDropdown(true)}
              placeholder={isTeams ? 'All teams — type to search' : 'All pairs — type to search'}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
            {selectedTeam && (
              <button
                onClick={() => { setSelectedTeam(''); setSearchText(''); }}
                className="absolute right-2 top-8 text-gray-400 hover:text-gray-600 text-sm"
              >✕</button>
            )}
            {showDropdown && !selectedTeam && (() => {
              const q = searchText.toLowerCase();
              const filtered = q
                ? participants.filter(p => p.name.toLowerCase().includes(q) || String(p.number).includes(q))
                : participants;
              if (filtered.length === 0 && q) return <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-auto"><div className="px-3 py-2 text-sm text-gray-400">No matches</div></div>;
              if (filtered.length === 0) return null;
              return (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-auto">
                  {filtered.map(p => (
                    <div
                      key={p.id}
                      onClick={() => { setSelectedTeam(p.id); setSearchText(`#${p.number} ${p.name}`); setShowDropdown(false); }}
                      className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer"
                    >
                      #{p.number} {p.name}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Filters */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Filters</label>
            <div className="space-y-2">
              {availableFilters.map(f => {
                const disabled = f.needsBidding && !hasBidding;
                return (
                  <label key={f.key} className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={selectedFilters.includes(f.key)}
                      onChange={() => !disabled && toggleFilter(f.key)}
                      disabled={disabled}
                      className="rounded"
                    />
                    <span className={disabled ? 'text-gray-400' : 'text-gray-700'}>
                      {f.hasInput ? (
                        <>
                          {f.label.split('%')[0].split('IMPs')[0]}
                          <input
                            type="number"
                            value={f.inputValue}
                            onChange={(e) => f.onInput(e.target.value)}
                            className="w-12 mx-1 px-1 py-0.5 border border-gray-300 rounded text-center text-sm"
                            onClick={(e) => e.stopPropagation()}
                          />
                          {f.label.includes('%') ? '%' : 'IMPs'}
                        </>
                      ) : f.label}
                      {disabled && <span className="text-xs text-gray-400 ml-1">(requires bidding data)</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleCreate}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Deal Set'}
            </button>
            <button onClick={() => setStep('pick')} className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50">
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function TypeGroupedList({ tournaments, expandedTournaments, setExpandedTournaments, onStageToggle, onEventToggle, onTournamentToggle, selectedStageIds }) {
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
        <div key={section.key} className="bg-white border border-gray-200 rounded-lg p-4">
          <label className="block text-sm font-bold text-gray-700 mb-2">{section.label}</label>
          <div className="space-y-1">
            {section.data.map(t => (
              <TournamentRow
                key={`${section.key}-${t.id}`}
                tournament={t}
                expanded={!!expandedTournaments[`${section.key}-${t.id}`]}
                onToggle={() => setExpandedTournaments(prev => ({ ...prev, [`${section.key}-${t.id}`]: !prev[`${section.key}-${t.id}`] }))}
                onStageToggle={(ev, stg) => onStageToggle(ev, stg, t)}
                onEventToggle={(ev) => onEventToggle(ev, t)}
                onTournamentToggle={() => onTournamentToggle(t)}
                selectedStageIds={selectedStageIds}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}


function TournamentRow({ tournament, expanded, onToggle, onStageToggle, onEventToggle, onTournamentToggle, selectedStageIds }) {
  const t = tournament;
  const events = t.bg_events || [];
  const [expandedEvents, setExpandedEvents] = useState({});

  const typeLabel = (type) => type === 'teams' ? 'TEAMS' : 'PAIRS';

  const totalStages = events.reduce((sum, ev) => sum + (ev.bg_stages || []).length, 0);
  const tournamentSelectedCount = events.reduce((sum, ev) =>
    sum + (ev.bg_stages || []).filter(s => selectedStageIds.has(s.id)).length, 0
  );
  const allChecked = totalStages > 0 && tournamentSelectedCount === totalStages;
  const someChecked = tournamentSelectedCount > 0 && !allChecked;

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      {/* Tournament header */}
      <div className="flex items-center px-4 py-3 bg-gray-50 hover:bg-gray-100">
        <input
          type="checkbox"
          checked={allChecked}
          ref={el => { if (el) el.indeterminate = someChecked; }}
          onChange={onTournamentToggle}
          className="rounded mr-3 flex-shrink-0"
        />
        <button
          onClick={onToggle}
          className="flex-1 text-left flex items-center justify-between"
        >
          <div className="flex items-baseline gap-1">
            <span className="text-gray-400 text-xs mr-1">{expanded ? '▾' : '▸'}</span>
            <span className="text-base font-bold text-gray-800">{t.name}</span>
          </div>
          {t.date_start && <span className="text-sm text-gray-500">{t.date_start}</span>}
        </button>
      </div>

      {/* Events */}
      {expanded && events.map(ev => {
        const stages = ev.bg_stages || [];
        const isEventExpanded = !!expandedEvents[ev.id];
        const eventSelectedCount = stages.filter(s => selectedStageIds.has(s.id)).length;
        const allChecked = stages.length > 0 && eventSelectedCount === stages.length;
        const someChecked = eventSelectedCount > 0 && !allChecked;

        return (
          <div key={ev.id} className="border-t border-gray-200">
            {/* Event row */}
            <div className="flex items-center px-4 py-2.5 pl-8 hover:bg-gray-50">
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => { if (el) el.indeterminate = someChecked; }}
                onChange={() => onEventToggle(ev)}
                className="rounded mr-3 flex-shrink-0"
              />
              <button
                onClick={() => setExpandedEvents(prev => ({ ...prev, [ev.id]: !prev[ev.id] }))}
                className="flex-1 text-left flex items-center justify-between"
              >
                <div className="flex items-baseline gap-1">
                  <span className="text-gray-400 text-xs mr-1">{isEventExpanded ? '▾' : '▸'}</span>
                  <span className="font-bold text-gray-700">{ev.name}</span>
                  <span className="text-sm text-gray-400 ml-1">– {typeLabel(ev.type)} ({ev.scoring?.toUpperCase()})</span>
                </div>
              </button>
            </div>

            {/* Stages */}
            {isEventExpanded && stages.map(stage => (
              <label
                key={stage.id}
                className="flex items-center pl-16 pr-4 py-2 hover:bg-blue-50 border-t border-gray-100 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedStageIds.has(stage.id)}
                  onChange={() => onStageToggle(ev, stage)}
                  className="rounded mr-3"
                />
                <span className="font-semibold text-gray-600">{stage.name}</span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}


function Header({ onBack, title }) {
  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
      <button onClick={onBack} className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50">
        &larr; Back
      </button>
      <h1 className="text-lg font-bold">{title}</h1>
    </div>
  );
}
