import { useState, useEffect, useRef } from 'react';
import { supabase as defaultSupabase } from './supabase.js';

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

const KIND_BADGES = {
  tourney: { label: 'Tourney', cls: 'bg-blue-100 text-blue-800' },
  mbc: { label: 'Casual', cls: 'bg-gray-100 text-gray-700' },
  team: { label: 'Team', cls: 'bg-purple-100 text-purple-800' },
};

// Format options offered in the config step. 'swiss' is stored as a pairs
// event with a swiss marker in source_meta (no schema change).
const FORMATS = [
  { key: 'teams', label: 'Team game' },
  { key: 'pairs', label: 'Pairs' },
  { key: 'swiss', label: 'Swiss pairs' },
];

// Map a scraped event (type + source_meta) to a Format key.
function eventToFormat(ev) {
  if (ev?.type === 'teams') return 'teams';
  if (ev?.source_meta?.format === 'swiss') return 'swiss';
  return 'pairs';
}

export default function RetrieveDeals({ supabase: sbProp, userId, onBack, onRetrieved }) {
  const supabase = sbProp || defaultSupabase;

  const [step, setStep] = useState('source'); // 'source' | 'config'
  const [source, setSource] = useState(null); // 'url' | 'bbo'
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  // BBO source state
  const [bboUser, setBboUser] = useState('');
  const [bboStart, setBboStart] = useState('');
  const [bboEnd, setBboEnd] = useState('');
  const [bboSessions, setBboSessions] = useState(null);
  const [bboSelectedKey, setBboSelectedKey] = useState('');

  // Config step state (populated after retrieval)
  const [tournament, setTournament] = useState(null);
  const [event, setEvent] = useState(null);
  const [format, setFormat] = useState('pairs');
  const [scoring, setScoring] = useState('mp');
  const [participants, setParticipants] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [searchText, setSearchText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Retrieval ──────────────────────────────────────────────────
  const loadTournament = async (tournamentId) => {
    const { data, error: dbErr } = await supabase
      .from('bg_tournaments')
      .select(`
        id, name, source_format,
        bg_events ( id, name, type, scoring, event_order, source_meta,
          bg_stages ( id, name, stage_order )
        )
      `)
      .eq('id', tournamentId)
      .single();
    if (dbErr || !data) throw new Error(dbErr?.message || 'Could not load the retrieved tournament.');

    const events = (data.bg_events || []).sort((a, b) => (a.event_order || 0) - (b.event_order || 0));
    // Primary event = the one with the most stages (usually the only one).
    const primary = events.slice().sort(
      (a, b) => (b.bg_stages?.length || 0) - (a.bg_stages?.length || 0)
    )[0] || events[0];
    if (!primary) throw new Error('The retrieved tournament has no events.');

    setTournament(data);
    setEvent(primary);
    setFormat(eventToFormat(primary));
    setScoring(primary.scoring === 'imp' ? 'imp' : 'mp');

    const stageIds = (primary.bg_stages || []).map((s) => s.id);
    await loadParticipants(primary.id, stageIds);
    setStep('config');
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
    const filtered = allParts.filter((p) => activeIds.has(p.id));
    setParticipants(filtered.length > 0 ? filtered : allParts);
  };

  const handleRetrieveUrl = async () => {
    setError('');
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !name.trim()) return;
    setStatus('Retrieving deals...');
    setLoading(true);
    try {
      const resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl, name: name.trim(), user_id: userId }),
      });
      const result = await resp.json();
      if (!resp.ok || result.error) throw new Error(result.error || 'Retrieval failed');
      if (!result.tournament_id) throw new Error('Retrieval succeeded but no tournament was returned.');
      await loadTournament(result.tournament_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  const bboPost = async (payload) => {
    const resp = await fetch('/api/bbo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!resp.ok || result.error) throw new Error(result.error || 'Request failed');
    return result;
  };

  const handleBboFind = async () => {
    setError('');
    if (!bboUser.trim() || !bboStart) return;
    setStatus('Fetching hands from BBO...');
    setLoading(true);
    try {
      const result = await bboPost({
        action: 'sessions',
        username: bboUser.trim(),
        start_date: bboStart,
        end_date: bboEnd || bboStart,
      });
      setBboSessions(result.sessions);
      setBboSelectedKey('');
      if (!result.sessions.length) setError('No hands found for that user and date range');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  const handleRetrieveBbo = async () => {
    setError('');
    if (!bboSelectedKey || !name.trim()) return;
    setStatus('Importing session (fetching travellers)...');
    setLoading(true);
    try {
      const result = await bboPost({
        action: 'import',
        username: bboUser.trim(),
        start_date: bboStart,
        end_date: bboEnd || bboStart,
        keys: [bboSelectedKey],
        names: { [bboSelectedKey]: name.trim() },
        user_id: userId,
      });
      if (!result.tournament_id) throw new Error('Import succeeded but no tournament was returned.');
      await loadTournament(result.tournament_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  // ── Create ─────────────────────────────────────────────────────
  const handleCreate = async () => {
    setError('');
    if (!name.trim()) { setError('Give your deal set a name.'); return; }
    setLoading(true);
    setStatus('Creating deal set...');
    try {
      const desiredType = format === 'teams' ? 'teams' : 'pairs';
      const swiss = format === 'swiss';

      // Write back the user's Format/Scoring correction to the event.
      const metaFormat = event.source_meta?.format;
      const needsMetaChange = swiss ? metaFormat !== 'swiss' : metaFormat === 'swiss';
      if (event.type !== desiredType || event.scoring !== scoring || needsMetaChange) {
        const newMeta = { ...(event.source_meta || {}) };
        if (swiss) newMeta.format = 'swiss';
        else if (newMeta.format === 'swiss') delete newMeta.format;
        await supabase
          .from('bg_events')
          .update({ type: desiredType, scoring, source_meta: newMeta })
          .eq('id', event.id);
      }

      const stageIds = (event.bg_stages || []).map((s) => s.id);
      const selections = (event.bg_stages || []).map((stg) => ({
        tournament_id: tournament.id, tournament_name: tournament.name,
        event_id: event.id, event_name: event.name,
        event_type: desiredType, event_scoring: scoring,
        stage_id: stg.id, stage_name: stg.name,
      }));

      const team = selectedTeam ? participants.find((p) => p.id === selectedTeam) : null;
      const filters = {
        mode: 'custom',
        format,
        stage_ids: stageIds,
        selections,
        active_filters: [],
      };
      if (stageIds.length === 1 && selections[0]) {
        filters.stage_id = selections[0].stage_id;
        filters.stage_name = selections[0].stage_name;
      }
      if (team) {
        filters.participant_id = team.id;
        filters.participant_name = team.name;
        if (desiredType !== 'teams') filters.participant_number = team.number;
      }

      const { error: dbErr } = await supabase
        .from('bsd_game_analyses')
        .insert({
          user_id: userId,
          name: name.trim(),
          event_id: event.id,
          participant_id: team?.id || null,
          filters,
        });
      if (dbErr) throw new Error(dbErr.message);
      onRetrieved();
    } catch (e) {
      setError(e.message);
      setLoading(false);
      setStatus('');
    }
  };

  // ── Render ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => {}} title="Retrieve played hands" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'config') {
    const isTeams = format === 'teams';
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => setStep('source')} title="Retrieve played hands" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
            <p className="text-sm text-gray-500">
              Retrieved <span className="font-medium text-gray-700">{tournament?.name}</span>
            </p>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Format</label>
              <div className="flex gap-2 flex-wrap">
                {FORMATS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFormat(f.key)}
                    className={`px-3 py-1.5 rounded text-sm border ${
                      format === f.key
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Scoring</label>
              <div className="flex gap-2">
                {[{ key: 'mp', label: 'MP' }, { key: 'imp', label: 'IMP' }].map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setScoring(s.key)}
                    className={`px-4 py-1.5 rounded text-sm border ${
                      scoring === s.key
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative" ref={dropdownRef}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isTeams ? 'Your team' : 'Your pair'}
              </label>
              <input
                type="text"
                value={searchText}
                onChange={(e) => { setSearchText(e.target.value); setShowDropdown(true); setSelectedTeam(''); }}
                onFocus={() => setShowDropdown(true)}
                placeholder={isTeams ? 'Type to find your team' : 'Type to find your pair'}
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
                  ? participants.filter((p) => p.name.toLowerCase().includes(q) || String(p.number).includes(q))
                  : participants;
                if (filtered.length === 0) {
                  return (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-auto">
                      <div className="px-3 py-2 text-sm text-gray-400">{q ? 'No matches' : 'No participants found'}</div>
                    </div>
                  );
                }
                return (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-auto">
                    {filtered.map((p) => (
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

            <div className="pt-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={!name.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                Create
              </button>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  // step === 'source'
  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={onBack} title="Retrieve played hands" />
      <div className="px-6 py-4 max-w-2xl">
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Wednesday Pairs with Sridhar"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setSource('bbo'); setError(''); }}
                className={`px-4 py-2 rounded text-sm border ${
                  source === 'bbo'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                BBO deals
              </button>
              <button
                type="button"
                onClick={() => { setSource('url'); setError(''); }}
                className={`px-4 py-2 rounded text-sm border ${
                  source === 'url'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Other deals
              </button>
            </div>
          </div>

          {source === 'url' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste tournament results URL..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
                />
                <button
                  type="button"
                  onClick={handleRetrieveUrl}
                  disabled={!url.trim() || !name.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Retrieve
                </button>
              </div>
            </div>
          )}

          {source === 'bbo' && (
            <div className="space-y-4">
              <div className="flex gap-2 items-end flex-wrap">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">BBO username</label>
                  <input
                    type="text"
                    value={bboUser}
                    onChange={(e) => setBboUser(e.target.value)}
                    placeholder="whose hands?"
                    className="w-36 px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
                  <input
                    type="date"
                    value={bboStart}
                    onChange={(e) => setBboStart(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
                  <input
                    type="date"
                    value={bboEnd}
                    onChange={(e) => setBboEnd(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleBboFind}
                  disabled={!bboUser.trim() || !bboStart}
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Find Sessions
                </button>
              </div>

              {bboSessions && bboSessions.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-gray-600">Pick one session:</p>
                  <div className="border border-gray-200 rounded divide-y divide-gray-100">
                    {bboSessions.map((s) => {
                      const badge = KIND_BADGES[s.kind] || KIND_BADGES.mbc;
                      return (
                        <label
                          key={s.key}
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50"
                        >
                          <input
                            type="radio"
                            name="bbo-session"
                            checked={bboSelectedKey === s.key}
                            onChange={() => setBboSelectedKey(s.key)}
                          />
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <span className="text-sm flex-1">
                            {s.label}
                            {s.opponents && <span className="text-gray-500"> vs {s.opponents}</span>}
                          </span>
                          <span className="text-xs text-gray-500">{s.boards} boards</span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={handleRetrieveBbo}
                    disabled={!bboSelectedKey || !name.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                  >
                    Retrieve
                  </button>
                  {!name.trim() && bboSelectedKey && (
                    <p className="text-sm text-gray-500">Enter a name above to retrieve.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}
