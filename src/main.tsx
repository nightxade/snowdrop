import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createShrike, ShrikeProvider } from '@/app';
import '@/ui/styles/global.css';

// Themes apply immediately (the welcome screen is themed too); connecting
// waits until a backend has been chosen, which <App> handles.
const shrike = createShrike({ document });
if (import.meta.env.DEV) {
  // Dynamic import keeps the dev helpers (and their mock import) out of production bundles.
  void import('@/app/devTools').then(({ installDevTools }) => {
    installDevTools(shrike);
  });
}
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ShrikeProvider shrike={shrike}>
      <App
        onBackendChange={() => {
          // createShrike picks the transport once; a new choice needs a fresh instance.
          shrike.flush();
          window.location.reload();
        }}
      />
    </ShrikeProvider>
  </StrictMode>,
);

// Debounced state (drafts) must reach storage even if the tab closes mid-burst.
window.addEventListener('pagehide', () => {
  shrike.flush();
});
