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

export default function RetrieveDeals({ onBack, onRetrieved }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

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
        body: JSON.stringify({ url: trimmedUrl, name: trimmedName }),
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100">
        <Header onBack={() => {}} title="Retrieve Played Deals" />
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
