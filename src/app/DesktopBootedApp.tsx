/**
 * Builds the real Snowdrop instance once encrypted storage is unlocked
 * (`StorageGate`) and renders what `src/main.tsx` renders for the browser
 * build: safe mode (?safe=1 or a held Shift), native dev tools in
 * development, and a flush on page hide.
 */
import { useEffect, useState } from 'react';
import type { KeyValueStorage, MessageRepository } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
import { App } from './App';
import { createSnowdrop } from './createSnowdrop';
import { SnowdropProvider } from './SnowdropProvider';

export interface DesktopBootedAppProps {
  storage: KeyValueStorage;
  repository: MessageRepository;
  document?: ThemeDocument;
}

export function DesktopBootedApp({ storage, repository, document }: DesktopBootedAppProps) {
  const [{ snowdrop, safeMode }] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const safe = params.get('safe') === '1';
    return {
      snowdrop: createSnowdrop({
        ...(document ? { document } : {}),
        safeMode: safe,
        storage,
        repository,
      }),
      safeMode: safe,
    };
  });

  useEffect(() => {
    if (safeMode) {
      snowdrop.stores.ui.getState().pushToast({
        message: 'Safe mode: imported themes and Custom CSS are off until you reload.',
        kind: 'info',
        source: 'core',
      });
      return;
    }
    // A held Shift auto-repeats; a single press (typing a capital) doesn't count.
    const onShift = (event: KeyboardEvent | PointerEvent) => {
      const held =
        event instanceof KeyboardEvent ? event.key === 'Shift' && event.repeat : event.shiftKey;
      if (!held) return;
      const params = new URLSearchParams(window.location.search);
      params.set('safe', '1');
      snowdrop.flush();
      window.location.search = params.toString();
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('pointermove', onShift);
    const timer = window.setTimeout(() => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('pointermove', onShift);
    }, 1500);
    return () => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('pointermove', onShift);
      window.clearTimeout(timer);
    };
  }, [snowdrop, safeMode]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Dynamic import keeps the dev helpers (and their mock import) out of production bundles.
    void import('./devTools').then(({ installDevTools }) => {
      installDevTools(snowdrop);
    });
  }, [snowdrop]);

  useEffect(() => {
    // Debounced state (drafts) must reach storage even if the window closes mid-burst.
    const onHide = () => {
      snowdrop.flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, [snowdrop]);

  return (
    <SnowdropProvider snowdrop={snowdrop}>
      <App
        onBackendChange={() => {
          snowdrop.flush();
          window.location.reload();
        }}
      />
    </SnowdropProvider>
  );
}
