import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App,
  createSnowdrop,
  desktopStorageAdmin,
  DesktopBootedApp,
  isTauri,
  SnowdropProvider,
  StorageGate,
} from '@/app';
import '@/ui/styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

if (isTauri()) {
  // The desktop app's data is encrypted at rest (docs/ENCRYPTION.md):
  // `StorageGate` owns everything that has to happen before a Snowdrop
  // instance — needing setup, locked, or unavailable — can even exist.
  createRoot(container).render(
    <StrictMode>
      <StorageGate admin={desktopStorageAdmin()} document={document}>
        {({ storage, repository }) => (
          <DesktopBootedApp storage={storage} repository={repository} document={document} />
        )}
      </StorageGate>
    </StrictMode>,
  );
} else {
  bootBrowser(container);
}

/**
 * Themes apply immediately (the welcome screen is themed too); connecting
 * waits until a backend has been chosen, which <App> handles.
 * Safe mode (?safe=1): imported themes and Custom CSS are skipped, so a theme
 * that breaks the UI can always be removed. Holding Shift while Snowdrop loads
 * does the same: we watch for it briefly and reload into ?safe=1.
 *
 * Browser/dev/mock mode only: there's no vault, so storage stays exactly as
 * it was before encrypted storage existed (plaintext, via the defaults
 * `createSnowdrop` already falls back to).
 */
function bootBrowser(container: HTMLElement): void {
  const params = new URLSearchParams(window.location.search);
  const safeMode = params.get('safe') === '1';
  const snowdrop = createSnowdrop({ document, safeMode });
  if (!safeMode) {
    const onShift = (event: KeyboardEvent | PointerEvent) => {
      // A held Shift auto-repeats; a single press (typing a capital) doesn't count.
      const held =
        event instanceof KeyboardEvent ? event.key === 'Shift' && event.repeat : event.shiftKey;
      if (!held) return;
      params.set('safe', '1');
      snowdrop.flush();
      window.location.search = params.toString();
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('pointermove', onShift);
    setTimeout(() => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('pointermove', onShift);
    }, 1500);
  } else {
    snowdrop.stores.ui.getState().pushToast({
      message: 'Safe mode: imported themes and Custom CSS are off until you reload.',
      kind: 'info',
      source: 'core',
    });
  }
  if (import.meta.env.DEV) {
    // Dynamic import keeps the dev helpers (and their mock import) out of production bundles.
    void import('@/app/devTools').then(({ installDevTools }) => {
      installDevTools(snowdrop);
    });
  }

  createRoot(container).render(
    <StrictMode>
      <SnowdropProvider snowdrop={snowdrop}>
        <App
          onBackendChange={() => {
            // createSnowdrop picks the transport once; a new choice needs a fresh instance.
            snowdrop.flush();
            window.location.reload();
          }}
        />
      </SnowdropProvider>
    </StrictMode>,
  );

  // Debounced state (drafts) must reach storage even if the tab closes mid-burst.
  window.addEventListener('pagehide', () => {
    snowdrop.flush();
  });
}
