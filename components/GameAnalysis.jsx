import { useState, useRef } from 'react';
import AnalysisList from '../src/AnalysisList.jsx';
import NewAnalysis from '../src/NewAnalysis.jsx';
import AnalysisView from '../src/AnalysisView.jsx';

/**
 * Game Analysis module — called from bsd-app when "My Games" is clicked.
 *
 * @param {object} props.supabase - Supabase client instance (shared with bsd-app)
 * @param {string} props.userId - Current user ID
 * @param {string} props.userEmail - Current user email
 * @param {boolean} props.isAdmin - Whether user is admin (controls tournament list visibility)
 * @param {function} props.onBack - Back navigation handler
 * @param {React.ComponentType} props.Header - Header component from bsd-app
 */
export default function GameAnalysis({ supabase, userId, userEmail, isAdmin, onLogout, onBack, Header, DiscussionView }) {
  const [view, setView] = useState('list');
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const displayRowsCache = useRef({});

  if (view === 'new') {
    return (
      <NewAnalysis
        supabase={supabase}
        userId={userId}
        isAdmin={isAdmin}
        onBack={() => setView('list')}
        onCreated={(analysis) => {
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
      onOpen={(analysis) => { setActiveAnalysis(analysis); setView('view'); }}
      onLogout={onLogout}
      onBack={onBack}
      Header={Header}
      displayRowsCache={displayRowsCache.current}
    />
  );
}
