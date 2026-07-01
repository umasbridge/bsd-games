import { useState } from 'react';
import { supabase as defaultSupabase } from './supabase.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;
  const [d, m, y] = parts;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(d)} ${months[parseInt(m) - 1] || m} ${y}`;
}

export default function RetrieveDeals({ supabase: sbProp, onBack, onRetrieved }) {
  const supabase = sbProp || defaultSupabase;
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [scraping, setScraping] = useState(false);

  // Discovery results
  const [tournamentName, setTournamentName] = useState('');
  const [events, setEvents] = useState([]); // event_groups
  const [selectedUrls, setSelectedUrls] = useState(new Set());

  const handleDiscover = async () => {
    setError('');
    const trimmed = url.trim();
    if (!trimmed) return;

    setStatus('Discovering events...');
    setDiscovering(true);

    try {
      const resp = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const result = await resp.json();
      if (!resp.ok || result.error) {
        setError(result.error || 'Discovery failed');
        setDiscovering(false);
        return;
      }

      // Discovery saved to DB — go back to tournament picker
      setDiscovering(false);
      setStatus('');
      onRetrieved();
    } catch (e) {
      setError(e.message);
      setDiscovering(false);
    }
  };

  const toggleEvent = (eventUrl) => {
    setSelectedUrls(prev => {
      const next = new Set(prev);
      if (next.has(eventUrl)) next.delete(eventUrl);
      else next.add(eventUrl);
      return next;
    });
  };

  const toggleGroup = (group) => {
    const sessions = group.sessions || [];
    const allSelected = sessions.every(s => selectedUrls.has(s.url));
    setSelectedUrls(prev => {
      const next = new Set(prev);
      for (const s of sessions) {
        if (allSelected) next.delete(s.url);
        else next.add(s.url);
      }
      return next;
    });
  };

  const handleScrape = async () => {
    if (selectedUrls.size === 0) return;
    setError('');
    setScraping(true);

    const selected = events.flatMap(g => (g.sessions || [g]).filter(s => selectedUrls.has(s.url)));
    let completed = 0;

    for (const event of selected) {
      completed++;
      setStatus(`Scraping ${completed}/${selected.length}: ${event.name}...`);
      try {
        const scrapeUrl = event.url.replace(/&amp;/g, '&');
        const resp = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: scrapeUrl }),
        });
        const result = await resp.json();
        if (!resp.ok) {
          console.error(`Scrape error for ${event.name}:`, result.error);
        }
      } catch (e) {
        console.error(`Scrape error for ${event.name}:`, e.message);
      }
    }

    setScraping(false);
    setStatus('');
    onRetrieved();
  };

  // Loading states
  if (discovering) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => { setDiscovering(false); setStatus(''); }} title="Retrieve Played Deals" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  if (scraping) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => {}} title="Retrieving Deals" />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  // Event picker (after discovery)
  if (events.length > 0) {
    const totalSelected = events.reduce((sum, g) =>
      sum + g.sessions.filter(s => selectedUrls.has(s.url)).length, 0
    );

    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => { setEvents([]); setTournamentName(''); }} title="Select Events to Retrieve" />
        <div className="px-6 py-4 max-w-2xl space-y-4">
          {tournamentName && (
            <p className="text-sm font-bold text-gray-700">{tournamentName}</p>
          )}

          <div className="space-y-2">
            {events.map((group, gi) => (
              <EventGroup
                key={gi}
                group={group}
                selectedUrls={selectedUrls}
                onToggleSession={toggleEvent}
                onToggleGroup={toggleGroup}
              />
            ))}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {totalSelected > 0 && (
            <button
              onClick={handleScrape}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
            >
              Retrieve Selected
            </button>
          )}
        </div>
      </div>
    );
  }

  // URL input (initial state)
  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={onBack} title="Retrieve Played Deals" />
      <div className="px-6 py-4 max-w-2xl">
        <form className="bg-white border border-gray-200 rounded-lg p-4" noValidate onSubmit={(e) => { e.preventDefault(); handleDiscover(); }}>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tournament URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste tournament results URL..."
              className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
              autoFocus
            />
            <button
              type="submit"
              disabled={!url.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Discover
            </button>
          </div>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        </form>
      </div>
    </div>
  );
}

function EventGroup({ group, selectedUrls, onToggleSession, onToggleGroup }) {
  const [expanded, setExpanded] = useState(false);
  const sessions = group.sessions || [];
  const selectedCount = sessions.filter(s => selectedUrls.has(s.url)).length;
  const allChecked = sessions.length > 0 && selectedCount === sessions.length;
  const someChecked = selectedCount > 0 && !allChecked;

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="flex items-center px-4 py-3 bg-gray-50 hover:bg-gray-100">
        <input
          type="checkbox"
          checked={allChecked}
          ref={el => { if (el) el.indeterminate = someChecked; }}
          onChange={() => onToggleGroup(group)}
          className="rounded mr-3 flex-shrink-0"
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 text-left flex items-center"
        >
          <span className="text-gray-400 text-xs mr-2">{expanded ? '▾' : '▸'}</span>
          <span className="text-sm font-bold text-gray-800 flex-1">{group.name}</span>
          <span className="text-xs text-gray-400">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </button>
      </div>
      {expanded && sessions.map((sess, i) => (
        <label
          key={`${sess.url}-${i}`}
          className="flex items-center pl-10 pr-4 py-2 hover:bg-blue-50 border-t border-gray-100 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={selectedUrls.has(sess.url)}
            onChange={() => onToggleSession(sess.url)}
            className="rounded mr-3"
          />
          <span className="text-sm text-gray-700 flex-1">
            {sess.name} ({formatDate(sess.date)})
          </span>
          {sess.boards && (
            <span className="text-xs text-gray-400">{sess.boards} boards</span>
          )}
        </label>
      ))}
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
