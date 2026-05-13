import { useState, useRef } from 'react';
import AnalysisList from '../src/AnalysisList.jsx';
import NewAnalysis from '../src/NewAnalysis.jsx';
import RetrieveDeals from '../src/RetrieveDeals.jsx';
import OpenConfig from '../src/OpenConfig.jsx';
import AnalysisView from '../src/AnalysisView.jsx';

export default function GameAnalysis({ supabase, userId, userEmail, isAdmin, onLogout, onBack, Header, DiscussionView }) {
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [retrievedTournament, setRetrievedTournament] = useState(null);
  const displayRowsCache = useRef({});

  if (view === 'new') {
    return (
      <NewAnalysis
        supabase={supabase}
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
        supabase={supabase}
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
        supabase={supabase}
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
        supabase={supabase}
        analysis={activeAnalysis}
        userId={userId}
        onBack={() => { setActiveAnalysis(null); setView('list'); }}
        onDisplayRows={(rows) => { displayRowsCache.current[activeAnalysis.id] = rows; }}
        DiscussionView={DiscussionView}
      />
    );
  }

  return (
    <AnalysisList
      supabase={supabase}
      userId={userId}
      userEmail={userEmail}
      isAdmin={isAdmin}
      onNew={() => setView('new')}
      onRetrieve={() => setView('retrieve')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setRetrievedTournament(null);
        setView('open-config');
      }}
      onLogout={onLogout}
      onBack={onBack}
      Header={Header}
      displayRowsCache={displayRowsCache.current}
    />
  );
}
