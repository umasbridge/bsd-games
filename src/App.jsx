import { useState, useEffect, useRef } from 'react';
import { supabase } from './supabase.js';
import AnalysisList from './AnalysisList.jsx';
import RetrieveDeals from './RetrieveDeals.jsx';
import AnalysisView from './AnalysisView.jsx';

export default function App() {
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const displayRowsCache = useRef({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setUserId(s?.user?.id || 'bfe92cae-3e6e-4078-8342-86ee8dfeb754');
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setUserId(s?.user?.id || 'bfe92cae-3e6e-4078-8342-86ee8dfeb754');
    });
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (view === 'retrieve-played') {
    return (
      <RetrieveDeals
        userId={userId}
        onBack={() => setView('list')}
        onRetrieved={() => setView('list')}
      />
    );
  }

  if (view === 'view' && activeAnalysis) {
    return (
      <AnalysisView
        analysis={activeAnalysis}
        userId={userId}
        onBack={() => { setActiveAnalysis(null); setView('list'); }}
        onDisplayRows={(rows) => { displayRowsCache.current[activeAnalysis.id] = rows; }}
      />
    );
  }

  return (
    <AnalysisList
      userId={userId}
      isAdmin={true}
      onCreateNew={() => setView('retrieve-played')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setView('view');
      }}
      displayRowsCache={displayRowsCache.current}
    />
  );
}
