import { useRef, useEffect } from 'react';

export default function GameViewer({ name, html, onExit }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (iframeRef.current && html) {
      const doc = iframeRef.current.contentDocument;
      doc.open();
      doc.write(html);
      doc.close();
    }
  }, [html]);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onExit}
            className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-bold">{name}</h1>
        </div>
      </div>

      {/* HTML content */}
      <iframe
        ref={iframeRef}
        className="flex-1 w-full border-0"
        title="Game Analysis"
      />
    </div>
  );
}
