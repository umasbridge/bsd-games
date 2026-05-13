import { useState } from 'react';
import { supabase as defaultSupabase } from './supabase.js';

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

export default function RetrieveDeals({ supabase: sbProp, onBack, onRetrieved }) {
  const supabase = sbProp || defaultSupabase;
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [scraping, setScraping] = useState(false);

  const handleSubmit = async () => {
    setError('');
    const trimmed = url.trim().replace(/#.*$/, '');
    if (!trimmed) return;

    const format = detectFormat(trimmed);
    if (!format) {
      setError('Unrecognized format. Supported: BFI/Tournament Calculator, BridgeWebs, LoveBridge.');
      return;
    }

    if (format !== 'srini' && format !== 'lovebridge' && format !== 'bridgewebs') {
      setError(`${format} scraper not yet implemented. Supported: Srini, LoveBridge, BridgeWebs.`);
      return;
    }

    setStatus('Loading tournament data...');
    setScraping(true);

    try {
      const resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const text = await resp.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        setError(`Server error (${resp.status}): scraper endpoint not available`);
        setScraping(false);
        return;
      }
      if (!resp.ok) {
        setError(result.error || 'Failed to load tournament');
        setScraping(false);
        return;
      }

      // Find the scraped tournament
      const { data } = await supabase
        .from('bg_tournaments')
        .select(`
          id, name, location, date_start, source_format,
          bg_events ( id, name, type, scoring, event_order,
            bg_stages ( id, name, stage_order, source_url )
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

      let matched = null;
      for (const t of sorted) {
        for (const ev of t.bg_events || []) {
          for (const stg of ev.bg_stages || []) {
            if (stg.source_url && trimmed.includes(new URL(stg.source_url).hostname)) {
              matched = t;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) break;
      }
      if (!matched && sorted.length > 0) matched = sorted[0];

      if (matched) {
        onRetrieved(matched);
      } else {
        setError('Tournament scraped but could not be found. Please try again.');
        setScraping(false);
      }
    } catch (e) {
      setError(e.message);
      setScraping(false);
    }
  };

  if (scraping && !error) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => { setScraping(false); setStatus(''); }} title="Retrieve Played Deals" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={onBack} title="Retrieve Played Deals" />
      <div className="px-6 py-4 max-w-2xl">
        <form className="bg-white border border-gray-200 rounded-lg p-4" noValidate onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tournament URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste any URL from the tournament..."
              className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
              autoFocus
            />
            <button
              type="submit"
              disabled={!url.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Retrieve
            </button>
          </div>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        </form>
      </div>
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
