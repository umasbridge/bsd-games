import { useState, useRef } from 'react';
import AnalysisList, { CreateDealSetPicker } from '../src/AnalysisList.jsx';
import RetrieveDeals from '../src/RetrieveDeals.jsx';
import OpenConfig from '../src/OpenConfig.jsx';
import AnalysisView from '../src/AnalysisView.jsx';

export default function GameAnalysis({ supabase, userId, userEmail, isAdmin, onLogout, onBack, Header, DiscussionView }) {
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [selectedStages, setSelectedStages] = useState(null);
  const displayRowsCache = useRef({});

  if (view === 'create') {
    return (
      <CreateDealSetPicker
        supabase={supabase}
        onBack={() => setView('list')}
        onRetrieve={() => setView('retrieve')}
        onCreateFromSelection={(stages) => {
          setSelectedStages(stages);
          setView('open-config');
        }}
      />
    );
  }

  if (view === 'retrieve') {
    return (
      <RetrieveDeals
        supabase={supabase}
        onBack={() => setView('create')}
        onRetrieved={() => setView('create')}
      />
    );
  }

  if (view === 'open-config') {
    return (
      <OpenConfig
        supabase={supabase}
        userId={userId}
        selectedStages={selectedStages}
        onBack={() => {
          setSelectedStages(null);
          setView('create');
        }}
        onProceed={() => {
          setSelectedStages(null);
          setActiveAnalysis(null);
          setView('list');
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
      onCreateNew={() => setView('create')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setView('view');
      }}
      onLogout={onLogout}
      onBack={onBack}
      Header={Header}
      displayRowsCache={displayRowsCache.current}
    />
  );
}
