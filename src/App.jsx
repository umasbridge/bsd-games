import { useState, useEffect, useRef } from 'react';
import { supabase } from './supabase.js';
import AnalysisList from './AnalysisList.jsx';
import NewAnalysis from './NewAnalysis.jsx';
import RetrieveDeals from './RetrieveDeals.jsx';
import OpenConfig from './OpenConfig.jsx';
import AnalysisView from './AnalysisView.jsx';

export default function App() {
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [retrievedTournament, setRetrievedTournament] = useState(null);
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

  if (view === 'new') {
    return (
      <NewAnalysis
        userId={userId}
        onBack={() => setView('list')}
        onCreated={(analysis) => {
          setActiveAnalysis(analysis);
          setView('view');
        }}
      />
    );
  }

  if (view === 'retrieve') {
    return (
      <RetrieveDeals
        onBack={() => setView('list')}
        onRetrieved={(tournament) => {
          setRetrievedTournament(tournament);
          setView('open-config');
        }}
      />
    );
  }

  if (view === 'open-config') {
    return (
      <OpenConfig
        userId={userId}
        analysis={retrievedTournament ? null : activeAnalysis}
        tournament={retrievedTournament}
        onBack={() => {
          setRetrievedTournament(null);
          setActiveAnalysis(null);
          setView('list');
        }}
        onProceed={(analysis) => {
          setRetrievedTournament(null);
          setActiveAnalysis(analysis);
          setView('view');
        }}
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
      onNew={() => setView('new')}
      onRetrieve={() => setView('retrieve')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setRetrievedTournament(null);
        setView('open-config');
      }}
      displayRowsCache={displayRowsCache.current}
    />
  );
}
