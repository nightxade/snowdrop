/**
 * Boot wiring shared by the browser bootstrap (src/main.tsx's `bootBrowser`)
 * and the desktop app once storage is unlocked (`DesktopBootedApp`): the
 * safe-mode toast or Shift-to-safe-mode listener, native dev tools in
 * development, and a flush on page hide. Both call sites used to duplicate
 * this; this is the one copy.
 */
import type { Snowdrop } from './createSnowdrop';

export interface InstallBootHelpersOptions {
  snowdrop: Snowdrop;
  /** `?safe=1`, or already known to be in safe mode. */
  safeMode: boolean;
}

/**
 * Call once per booted `Snowdrop` instance. Returns a cleanup function
 * (removes the Shift/pagehide listeners and clears the Shift-detection
 * timer); callers that never unmount (`bootBrowser`) can ignore it.
 */
export function installBootHelpers({ snowdrop, safeMode }: InstallBootHelpersOptions): () => void {
  const cleanups: Array<() => void> = [];

  if (safeMode) {
    snowdrop.stores.ui.getState().pushToast({
      message: 'Safe mode: imported themes and Custom CSS are off until you reload.',
      kind: 'info',
      source: 'core',
    });
  } else {
    // A held Shift auto-repeats; a single press (typing a capital) doesn't count.
    const onShift = (event: KeyboardEvent | PointerEvent) => {
      const held =
        event instanceof KeyboardEvent ? event.key === 'Shift' && event.repeat : event.shiftKey;
      if (!held) return;
      const params = new URLSearchParams(window.location.search);
      params.set('safe', '1');
      void snowdrop.admin.reload(params.toString());
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('pointermove', onShift);
    const timer = window.setTimeout(() => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('pointermove', onShift);
    }, 1500);
    cleanups.push(() => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('pointermove', onShift);
      window.clearTimeout(timer);
    });
  }

  if (import.meta.env.DEV) {
    // Dynamic import keeps the dev helpers (and their mock import) out of production bundles.
    void import('./devTools').then(({ installDevTools }) => {
      installDevTools(snowdrop);
    });
  }

  // Debounced state (drafts) must reach storage even if the window/tab closes mid-burst.
  const onHide = () => {
    snowdrop.flush();
  };
  window.addEventListener('pagehide', onHide);
  cleanups.push(() => {
    window.removeEventListener('pagehide', onHide);
  });

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
