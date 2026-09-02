import { useState, useEffect } from 'react';
import { supabase } from './supabase.js';
import AnalysisList from './AnalysisList.jsx';
import { RetrieveDeals } from 'games-retrieval';
import AnalysisView from './AnalysisView.jsx';

export default function App() {
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [activePlaySet, setActivePlaySet] = useState(null);

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
        supabase={supabase}
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
        onBack={() => { setActiveAnalysis(null); setActivePlaySet(null); setView('list'); }}
        playSet={activePlaySet}
      />
    );
  }

  const handleOpenPlaySet = (ps) => {
    setActiveAnalysis(ps.analysis);
    setActivePlaySet(ps);
    setView('view');
  };

  return (
    <AnalysisList
      userId={userId}
      isAdmin={true}
      onCreateNew={() => setView('retrieve-played')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setActivePlaySet(null);
        setView('view');
      }}
      onOpenPlaySet={handleOpenPlaySet}
    />
  );
}
