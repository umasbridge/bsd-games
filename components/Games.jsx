import { useState, useEffect } from 'react';
import { htmlToGame } from '../lib/htmlToGame.js';

/**
 * Games listing page.
 * @param {object} props
 * @param {object} props.supabase - Supabase client instance
 * @param {string} props.userId - Current user ID
 * @param {string} props.userEmail - Current user email
 * @param {function} props.onOpen - Called with gameId when user opens a game
 * @param {function} props.onLogout - Logout handler
 * @param {function} props.onBack - Back navigation handler
 * @param {React.ComponentType} props.Header - Header component (receives title, userEmail, onLogout, onBack)
 */
export default function Games({ supabase, userId, userEmail, onOpen, onLogout, onBack, Header }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNewGame, setShowNewGame] = useState(false);
  const [tournamentUrl, setTournamentUrl] = useState('');
  const [pairNumber, setPairNumber] = useState('');
  const [boardRange, setBoardRange] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  const fetchGames = async () => {
    const { data } = await supabase
      .from('bsd_games')
      .select('id, name, tournament_name, tournament_date, tournament_venue, tournament_url, pair_number, board_range, created_at, updated_at')
      .order('updated_at', { ascending: false });
    setGames(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchGames(); }, []);

  const handleDelete = async (game) => {
    if (!confirm(`Delete "${game.name}"? This cannot be undone.`)) return;
    await supabase.from('bsd_games').delete().eq('id', game.id);
    setGames((prev) => prev.filter((g) => g.id !== game.id));
  };

  const handleNewGame = async () => {
    if (!tournamentUrl.trim() || !pairNumber.trim()) return;
    setAnalyzing(true);
    setError('');

    try {
      // Clean URL: strip fragment (#...) and trailing whitespace
      let cleanUrl = tournamentUrl.trim().split('#')[0];
      // Ensure trailing slash for base URL
      if (!cleanUrl.endsWith('/')) cleanUrl += '/';

      const resp = await fetch('/api/bridge-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentUrl: cleanUrl,
          pairNumber: parseInt(pairNumber, 10),
          boardRange: boardRange.trim() || undefined,
        }),
      });

      const result = await resp.json();
      if (!resp.ok) {
        // Show just the last meaningful line of a Python traceback
        let msg = result.error || 'Analysis failed';
        const lastLine = msg.split('\n').filter(l => l.trim()).pop();
        if (lastLine && lastLine.includes('Error')) msg = lastLine;
        setError(msg);
        return;
      }

      const meta = result.meta || {};
      const name = meta.pairName || `Pair ${pairNumber}`;

      // Convert HTML to md + formatting using client-side converter
      const htmlContent = result.html || '';
      const { md, formatting } = htmlToGame(htmlContent);

      const { data, error: dbError } = await supabase
        .from('bsd_games')
        .insert({
          user_id: userId,
          name,
          md,
          formatting,
          html: htmlContent,
          tournament_name: meta.tournamentName || null,
          tournament_date: meta.tournamentDate || null,
          tournament_venue: meta.tournamentVenue || null,
          tournament_url: cleanUrl,
          pair_number: parseInt(pairNumber, 10),
          board_range: boardRange.trim() || null,
        })
        .select('id, name, tournament_name, tournament_date, tournament_venue, tournament_url, pair_number, board_range, created_at, updated_at')
        .single();

      if (!dbError && data) {
        setGames((prev) => [data, ...prev]);
      }

      setShowNewGame(false);
      setTournamentUrl('');
      setPairNumber('');
      setBoardRange('');
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      {Header && <Header title="My Games" userEmail={userEmail} onLogout={onLogout} onBack={onBack} />}

      {/* Actions */}
      <div className="px-6 py-4 flex gap-3 items-center">
        <button
          onClick={() => setShowNewGame(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        >
          New Game
        </button>
      </div>

      {/* New game input */}
      {showNewGame && (
        <div className="px-6 pb-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4 max-w-lg space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tournament URL <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={tournamentUrl}
                onChange={(e) => setTournamentUrl(e.target.value)}
                placeholder="https://bfi.net.in/wp-content/uploads/..."
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pair Number <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                value={pairNumber}
                onChange={(e) => setPairNumber(e.target.value)}
                placeholder="e.g. 9"
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Board Range <span className="text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                value={boardRange}
                onChange={(e) => setBoardRange(e.target.value)}
                placeholder="e.g. 1-10 (leave blank for all)"
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleNewGame()}
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleNewGame}
                disabled={!tournamentUrl.trim() || !pairNumber.trim() || analyzing}
                className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {analyzing ? 'Analyzing...' : 'Run Analysis'}
              </button>
              <button
                onClick={() => { setShowNewGame(false); setError(''); }}
                className="px-3 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50"
                disabled={analyzing}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Games list */}
      <div className="px-6">
        {loading ? (
          <p className="text-gray-400 py-8 text-center">Loading...</p>
        ) : games.length === 0 ? (
          <p className="text-gray-400 py-8 text-center">No games yet. Click "New Game" to analyze a tournament.</p>
        ) : (
          <div className="space-y-2">
            {games.map((game) => (
              <div
                key={game.id}
                className="bg-white rounded-lg px-4 py-3 flex items-center justify-between border border-gray-200 mobile-card-layout"
              >
                <div>
                  <p className="font-medium text-gray-800">
                    {[game.tournament_name, game.tournament_date, game.name]
                      .filter(Boolean)
                      .join(' .. ')}
                  </p>
                </div>
                <div className="flex gap-2 mobile-btn-group">
                  <button
                    onClick={() => onOpen(game.id)}
                    className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                  >
                    Open
                  </button>
                  <button
                    disabled
                    className="px-3 py-1 border border-gray-200 rounded text-sm text-gray-400 cursor-not-allowed"
                  >
                    Share
                  </button>
                  <button
                    disabled
                    className="border border-gray-200 rounded text-sm text-gray-400 cursor-not-allowed mobile-icon-btn"
                    title="Download PDF"
                  >
                    <svg className="mobile-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span className="mobile-hide-label">Download PDF</span>
                  </button>
                  <button
                    onClick={() => handleDelete(game)}
                    className="border border-gray-200 rounded text-sm text-red-600 hover:bg-red-50 mobile-icon-btn"
                    title="Delete"
                  >
                    <svg className="mobile-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    <span className="mobile-hide-label">Delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
