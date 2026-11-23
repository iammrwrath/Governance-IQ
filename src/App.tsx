import React from 'react';

export default function App() {
  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
      <iframe
        src="https://governance-script-444555191847.us-central1.run.app"
        title="Governance Presentation Deck Solution"
        style={{ width: '100%', height: '100%', border: 'none' }}
        allow="clipboard-read; clipboard-write; camera; microphone"
      />
    </div>
  );
}
