import { useState, useEffect } from 'react';
import { supabase } from './supabase.js';

export default function AnalysisList({ userId, onNew, onOpen }) {
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAnalyses = async () => {
    const { data } = await supabase
      .from('bsd_game_analyses')
      .select(`
        id, name, filters, created_at, updated_at, user_id, participant_id,
        bg_events ( id, name, type, scoring,
          bg_tournaments ( id, name, date_start, location, source_format )
        )
      `)
      .order('updated_at', { ascending: false });
    setAnalyses(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchAnalyses(); }, []);

  const handleDelete = async (analysis) => {
    if (!confirm(`Delete "${analysis.name}"? This cannot be undone.`)) return;
    await supabase.from('bsd_game_analyses').delete().eq('id', analysis.id);
    setAnalyses(prev => prev.filter(a => a.id !== analysis.id));
  };

  const isOwner = (a) => a.user_id === userId;

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { window.location.href = '/'; }}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-bold">My Games</h1>
        </div>
      </div>

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
                          disabled
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-gray-400 cursor-not-allowed"
                        >
                          Share
                        </button>
                        <button
                          disabled
                          className="px-3 py-1 border border-gray-200 rounded text-sm text-gray-400 cursor-not-allowed"
                          title="Download LIN"
                        >
                          LIN
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
    </div>
  );
}

function buildFilterDescription(filters, type) {
  const parts = [];
  if (filters.participant_name) parts.push(filters.participant_name);
  if (filters.mode === 'diff_contract') parts.push('Different contracts');
  if (filters.mode === 'diff_tricks') parts.push('Same contract, diff tricks');
  if (filters.board_start || filters.board_end) {
    parts.push(`Boards ${filters.board_start || '1'}–${filters.board_end || 'end'}`);
  }
  return parts.join(', ');
}
