import { useState, useRef } from 'react';
import AnalysisList from '../src/AnalysisList.jsx';
import RetrieveDeals from '../src/RetrieveDeals.jsx';
import AnalysisView from '../src/AnalysisView.jsx';

export default function GameAnalysis({ supabase, userId, userEmail, isAdmin, onLogout, onBack, Header, DiscussionView, ShareDialog, onDownloadLin }) {
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const displayRowsCache = useRef({});

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
      onCreateNew={() => setView('retrieve-played')}
      onOpen={(analysis) => {
        setActiveAnalysis(analysis);
        setView('view');
      }}
      onLogout={onLogout}
      onBack={onBack}
      Header={Header}
      displayRowsCache={displayRowsCache.current}
      onDownloadLin={onDownloadLin}
      ShareDialog={ShareDialog}
    />
  );
}
