import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createHearth, HearthProvider } from '@/app';
import '@/ui/styles/global.css';

// Themes apply immediately (the welcome screen is themed too); connecting
// waits until a backend has been chosen, which <App> handles.
const hearth = createHearth({ document });
if (import.meta.env.DEV) {
  // Dynamic import keeps the dev helpers (and their mock import) out of production bundles.
  void import('@/app/devTools').then(({ installDevTools }) => {
    installDevTools(hearth);
  });
}
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <HearthProvider hearth={hearth}>
      <App
        onBackendChange={() => {
          // createHearth picks the transport once; a new choice needs a fresh instance.
          hearth.flush();
          window.location.reload();
        }}
      />
    </HearthProvider>
  </StrictMode>,
);

// Debounced state (drafts) must reach storage even if the tab closes mid-burst.
window.addEventListener('pagehide', () => {
  hearth.flush();
});
