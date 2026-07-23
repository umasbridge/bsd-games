import { useState } from 'react';

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

export default function RetrieveDeals({ onBack, onRetrieved, mode = 'url', userId }) {
  const isBbo = mode === 'bbo';
  const title = isBbo ? 'Retrieve BBO Hands' : 'Retrieve Played Deals';

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const [bboName, setBboName] = useState('');
  const [bboUser, setBboUser] = useState('');
  const [bboStart, setBboStart] = useState('');
  const [bboEnd, setBboEnd] = useState('');
  const [bboSessions, setBboSessions] = useState(null);
  const [bboSelected, setBboSelected] = useState(new Set());

  const handleRetrieve = async () => {
    setError('');
    const trimmedUrl = url.trim();
    const trimmedName = name.trim();
    if (!trimmedUrl || !trimmedName) return;

    setStatus('Retrieving boards...');
    setLoading(true);

    try {
      const resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl, name: trimmedName, user_id: userId }),
      });
      const result = await resp.json();
      if (!resp.ok || result.error) {
        setError(result.error || 'Retrieval failed');
        setLoading(false);
        return;
      }

      setLoading(false);
      setStatus('');
      onRetrieved();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const bboPost = async (payload) => {
    const resp = await fetch('/api/bbo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!resp.ok || result.error) {
      throw new Error(result.error || 'Request failed');
    }
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
      setBboSelected(new Set());
      setLoading(false);
      setStatus('');
      if (!result.sessions.length) {
        setError('No hands found for that user and date range');
      }
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const handleBboImport = async () => {
    setError('');
    const keys = bboSessions.map((s) => s.key).filter((k) => bboSelected.has(k));
    const trimmedName = bboName.trim();
    if (!keys.length || !trimmedName) return;

    setStatus(`Importing ${keys.length} session${keys.length > 1 ? 's' : ''} (fetching travellers)...`);
    setLoading(true);
    try {
      const names = {};
      keys.forEach((k, i) => {
        names[k] = i === 0 ? trimmedName : `${trimmedName} (${i + 1})`;
      });
      await bboPost({
        action: 'import',
        username: bboUser.trim(),
        start_date: bboStart,
        end_date: bboEnd || bboStart,
        keys,
        names,
        user_id: userId,
      });
      setLoading(false);
      setStatus('');
      onRetrieved();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const toggleBboSession = (key) => {
    setBboSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => {}} title={title} />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-5 text-center space-y-3">
            <div className="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <p className="text-sm text-gray-600">{status}</p>
          </div>
        </div>
      </div>
    );
  }

  if (isBbo) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={onBack} title={title} />
        <div className="px-6 py-4 max-w-2xl">
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={bboName}
                onChange={(e) => setBboName(e.target.value)}
                placeholder="e.g. Wednesday IMP Pairs with Sridhar"
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                autoFocus
              />
            </div>

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
                <p className="text-sm text-gray-600">
                  {bboSessions.length} session{bboSessions.length > 1 ? 's' : ''} found — pick what to import:
                </p>
                <div className="border border-gray-200 rounded divide-y divide-gray-100">
                  {bboSessions.map((s) => {
                    const badge = KIND_BADGES[s.kind] || KIND_BADGES.mbc;
                    return (
                      <label
                        key={s.key}
                        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={bboSelected.has(s.key)}
                          onChange={() => toggleBboSession(s.key)}
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
                  onClick={handleBboImport}
                  disabled={!bboSelected.size || !bboName.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Import {bboSelected.size || ''} Selected
                </button>
                {!bboName.trim() && bboSelected.size > 0 && (
                  <p className="text-sm text-gray-500">Enter a name above to import.</p>
                )}
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onBack={onBack} title={title} />
      <div className="px-6 py-4 max-w-2xl">
        <form
          className="bg-white border border-gray-200 rounded-lg p-4 space-y-4"
          noValidate
          onSubmit={(e) => { e.preventDefault(); handleRetrieve(); }}
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Summer Nationals 2026"
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              autoFocus
            />
          </div>

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
                type="submit"
                disabled={!url.trim() || !name.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                Retrieve
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </div>
    </div>
  );
}
