import { useState } from 'react';
import AnalysisList from '../src/AnalysisList.jsx';
import { RetrieveDeals } from 'games-retrieval';
import { DealView, DealPlay } from 'games-display';

export default function GameAnalysis({ supabase, userId, userEmail, isAdmin, onLogout, onBack, Header, DiscussionView, ShareDialog, onDownloadLin }) {
  const [route, setRoute] = useState({ name: 'list' });

  if (route.name === 'retrieve') {
    return (
      <RetrieveDeals
        supabase={supabase}
        userId={userId}
        onBack={() => setRoute({ name: 'list' })}
        onRetrieved={() => setRoute({ name: 'list' })}
      />
    );
  }

  if (route.name === 'play' && route.playSet) {
    return (
      <DealPlay
        supabase={supabase}
        playSet={route.playSet}
        userId={userId}
        onBack={() => setRoute({ name: 'list' })}
        DiscussionView={DiscussionView}
      />
    );
  }

  if (route.name === 'view' && route.analysis) {
    return (
      <DealView
        supabase={supabase}
        analysis={route.analysis}
        userId={userId}
        onBack={() => setRoute({ name: 'list' })}
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
      onCreateNew={() => setRoute({ name: 'retrieve' })}
      onOpen={(analysis) => setRoute({ name: 'view', analysis })}
      onPlay={(playSet) => setRoute({ name: 'play', playSet })}
      onLogout={onLogout}
      onBack={onBack}
      Header={Header}
      onDownloadLin={onDownloadLin}
      ShareDialog={ShareDialog}
    />
  );
}
