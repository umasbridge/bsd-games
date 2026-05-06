import { useState, useEffect } from 'react';
import { supabase } from './supabase.js';

const FORMAT_PATTERNS = [
  { format: 'srini',      match: (u) => /\/(settings|p\d+)\.json/.test(u) || /bfi\.net\.in|\/wp-content\/uploads\//.test(u) },
  { format: 'bridgewebs', match: (u) => /bridgewebs\.com/.test(u) },
  { format: 'sg',         match: (u) => /wbbridge\.in/.test(u) },
  { format: 'lovebridge', match: (u) => /lovebridge\.com/.test(u) },
];

function detectFormat(url) {
  for (const { format, match } of FORMAT_PATTERNS) {
    if (match(url)) return format;
  }
  return null;
}

const FORMAT_LABELS = {
  srini: 'Srini', bridgewebs: 'BridgeWebs', sg: 'SG', lovebridge: 'LoveBridge',
};

export default function NewAnalysis({ userId, onBack, onCreated }) {
  const [step, setStep] = useState('pick'); // pick | scraping | filters
  const [tournaments, setTournaments] = useState([]);
  const [loadingTournaments, setLoadingTournaments] = useState(true);
  const [expandedTournament, setExpandedTournament] = useState(null);

  // URL input
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  // Selected event + stage
  const [event, setEvent] = useState(null);
  const [stage, setStage] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [participants, setParticipants] = useState([]);

  // Filters
  const [name, setName] = useState('');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [selectedFilters, setSelectedFilters] = useState([]);
  const [impThreshold, setImpThreshold] = useState('5');
  const [pctThreshold, setPctThreshold] = useState('40');
  const [saving, setSaving] = useState(false);

  const isTeams = event?.type === 'teams';

  // Load existing tournaments on mount
  useEffect(() => {
    loadTournaments();
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

    // Sort events and stages within each tournament
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

  const handleStageSelect = async (ev, stg, tourn) => {
    setEvent(ev);
    setStage(stg);
    setTournament(tourn);
    setName(`${tourn.name} - ${ev.name} - ${stg.name}`);
    await loadParticipants(ev.id, stg.id);
    setStep('filters');
  };

  const loadParticipants = async (eventId, stageId) => {
    // Get all event participants
    const { data: allParts } = await supabase
      .from('bg_participants')
      .select('id, number, name')
      .eq('event_id', eventId)
      .order('number');

    if (!stageId || !allParts?.length) {
      setParticipants(allParts || []);
      return;
    }

    // Filter to participants who have results in this stage
    const { data: results } = await supabase
      .from('bg_board_results')
      .select('ns_participant_id, ew_participant_id')
      .eq('stage_id', stageId);

    const activeIds = new Set();
    for (const r of (results || [])) {
      if (r.ns_participant_id) activeIds.add(r.ns_participant_id);
      if (r.ew_participant_id) activeIds.add(r.ew_participant_id);
    }

    setParticipants(allParts.filter(p => activeIds.has(p.id)));
  };

  const handleUrlSubmit = async () => {
    setError('');
    const trimmed = url.trim().replace(/#.*$/, '');
    if (!trimmed) return;

    const format = detectFormat(trimmed);
    if (!format) {
      setError('Unrecognized format. Supported: BFI/Tournament Calculator, BridgeWebs, WBBridge, LoveBridge.');
      return;
    }

    if (format !== 'srini' && format !== 'lovebridge' && format !== 'bridgewebs') {
      setError(`${format} scraper not yet implemented. Supported: Srini, LoveBridge, BridgeWebs.`);
      return;
    }

    setStatus('Scraping tournament data... This may take a few minutes.');
    setStep('scraping');

    try {
      const resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const result = await resp.json();
      if (!resp.ok) {
        setError(result.error || 'Scraping failed');
        setStep('pick');
        return;
      }

      // Reload tournaments to show newly scraped data
      await loadTournaments();
      setUrl('');
      setStep('pick');
      setStatus('');
    } catch (e) {
      setError(e.message);
      setStep('pick');
    }
  };

  const toggleFilter = (f) => {
    setSelectedFilters(prev =>
      prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]
    );
  };

  const matchedPair = playerSearch.trim()
    ? participants.find(p =>
        p.name.toLowerCase().includes(playerSearch.trim().toLowerCase())
      )
    : null;

  const handleCreate = async () => {
    if (!name.trim()) { setError('Give your analysis a name.'); return; }

    setSaving(true);
    setError('');

    const filters = { mode: 'custom', active_filters: selectedFilters };
    if (stage) {
      filters.stage_id = stage.id;
      filters.stage_name = stage.name;
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

    const { data, error: dbErr } = await supabase
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

    setSaving(false);

    if (dbErr) {
      setError(dbErr.message);
      return;
    }

    onCreated(data);
  };

  // ── Pick step: existing tournaments + URL input ────────────────

  if (step === 'pick') {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={onBack} title="Analyse New Game" />
        <div className="px-6 py-4 max-w-2xl space-y-4">

          {/* Add new tournament via URL */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Add Tournament</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste any URL from the tournament..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
              />
              <button
                onClick={handleUrlSubmit}
                disabled={!url.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                Scrape
              </button>
            </div>
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          {/* Existing tournaments */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Existing Tournaments
            </label>
            {loadingTournaments ? (
              <p className="text-gray-400 text-sm py-4 text-center">Loading...</p>
            ) : tournaments.length === 0 ? (
              <p className="text-gray-400 text-sm py-4 text-center">
                No tournaments yet. Paste a URL above to scrape one.
              </p>
            ) : (
              <div className="space-y-1">
                {tournaments.map(t => (
                  <TournamentRow
                    key={t.id}
                    tournament={t}
                    expanded={expandedTournament === t.id}
                    onToggle={() => setExpandedTournament(expandedTournament === t.id ? null : t.id)}
                    onStageSelect={(ev, stg) => handleStageSelect(ev, stg, t)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Scraping step ──────────────────────────────────────────────

  if (step === 'scraping') {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => { setStep('pick'); setStatus(''); }} title="Analyse New Game" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Filters step ───────────────────────────────────────────────

  const hasBidding = tournament?.source_format === 'lovebridge';

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

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={() => setStep('pick')} title="Analyse New Game" />
      <div className="px-6 py-4 max-w-2xl">
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          {/* Tournament + Event + Stage info */}
          <div className="bg-gray-50 rounded px-3 py-2 text-sm">
            <span className="font-medium">{tournament.name}</span>
            <span className="text-gray-500 ml-2">{tournament.date_start || ''}</span>
            <div className="text-gray-600">
              {event.name} – {event.type === 'teams' ? 'TEAMS' : 'PAIRS'} ({event.scoring?.toUpperCase()})
              {stage && <span className="font-medium text-gray-700 ml-1">· {stage.name}</span>}
            </div>
          </div>

          {/* Analysis name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Analysis Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
            />
          </div>

          {/* Team / Pair selection */}
          {isTeams ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Our Team</label>
              <select
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              >
                <option value="">Select team...</option>
                {participants.map(p => (
                  <option key={p.id} value={p.id}>#{p.number} {p.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Our Pair</label>
              <select
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              >
                <option value="">Select pair...</option>
                {participants.map(p => (
                  <option key={p.id} value={p.id}>#{p.number} {p.name}</option>
                ))}
              </select>
            </div>
          )}

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
              {saving ? 'Creating...' : 'Create Analysis'}
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


function TournamentRow({ tournament, expanded, onToggle, onStageSelect }) {
  const t = tournament;
  const events = t.bg_events || [];
  const [expandedEvent, setExpandedEvent] = useState(null);

  const typeLabel = (type) => type === 'teams' ? 'TEAMS' : 'PAIRS';

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      {/* Tournament header */}
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 bg-gray-50 flex items-center justify-between hover:bg-gray-100"
      >
        <div className="flex items-baseline gap-1">
          <span className="text-gray-400 text-xs mr-1">{expanded ? '▾' : '▸'}</span>
          <span className="text-base font-bold text-gray-800">{t.name}</span>
        </div>
        {t.date_start && <span className="text-sm text-gray-500">{t.date_start}</span>}
      </button>

      {/* Events (when tournament expanded) */}
      {expanded && events.map(ev => {
        const stages = ev.bg_stages || [];
        const isEventExpanded = expandedEvent === ev.id;

        return (
          <div key={ev.id} className="border-t border-gray-200">
            {/* Event row */}
            <button
              onClick={() => setExpandedEvent(isEventExpanded ? null : ev.id)}
              className="w-full text-left px-4 py-2.5 pl-10 hover:bg-gray-50 flex items-center justify-between"
            >
              <div className="flex items-baseline gap-1">
                <span className="text-gray-400 text-xs mr-1">{isEventExpanded ? '▾' : '▸'}</span>
                <span className="font-bold text-gray-700">{ev.name}</span>
                <span className="text-sm text-gray-400 ml-1">– {typeLabel(ev.type)} ({ev.scoring?.toUpperCase()})</span>
              </div>
            </button>

            {/* Stages (when event expanded) */}
            {isEventExpanded && stages.map(stage => (
              <button
                key={stage.id}
                onClick={() => onStageSelect(ev, stage)}
                className="w-full text-left pl-20 pr-4 py-2 hover:bg-blue-50 border-t border-gray-100 flex items-center"
              >
                <span className="font-semibold text-gray-600">{stage.name}</span>
              </button>
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
