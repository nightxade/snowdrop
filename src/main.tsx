import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createShrike, ShrikeProvider } from '@/app';
import '@/ui/styles/global.css';

// Themes apply immediately (the welcome screen is themed too); connecting
// waits until a backend has been chosen, which <App> handles.
// Safe mode (?safe=1): imported themes and Custom CSS are skipped, so a theme
// that breaks the UI can always be removed. Holding Shift while Shrike loads
// does the same: we watch for it briefly and reload into ?safe=1.
const params = new URLSearchParams(window.location.search);
const safeMode = params.get('safe') === '1';
const shrike = createShrike({ document, safeMode });
if (!safeMode) {
  const onShift = (event: KeyboardEvent | PointerEvent) => {
    // A held Shift auto-repeats; a single press (typing a capital) doesn't count.
    const held =
      event instanceof KeyboardEvent ? event.key === 'Shift' && event.repeat : event.shiftKey;
    if (!held) return;
    params.set('safe', '1');
    shrike.flush();
    window.location.search = params.toString();
  };
  window.addEventListener('keydown', onShift);
  window.addEventListener('pointermove', onShift);
  setTimeout(() => {
    window.removeEventListener('keydown', onShift);
    window.removeEventListener('pointermove', onShift);
  }, 1500);
} else {
  shrike.stores.ui.getState().pushToast({
    message: 'Safe mode: imported themes and Custom CSS are off until you reload.',
    kind: 'info',
    source: 'core',
  });
}
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
