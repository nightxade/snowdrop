/**
 * Builds the real Snowdrop instance once encrypted storage is unlocked
 * (`StorageGate`) and renders what `src/main.tsx` renders for the browser
 * build: safe mode (?safe=1), native dev tools in
 * development, and a flush on page hide.
 */
import { useEffect, useState } from 'react';
import type { HydratedKeyValue, MessageRepository } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
import { App } from './App';
import { createSnowdrop } from './createSnowdrop';
import { installBootHelpers } from './installBootHelpers';
import { SnowdropProvider } from './SnowdropProvider';

export interface DesktopBootedAppProps {
  storage: HydratedKeyValue;
  repository: MessageRepository;
  document?: ThemeDocument;
  /**
   * `StorageGate`'s registration hook for the close handshake
   * (docs/ENCRYPTION.md, "Close handshake"): called once, here, with the
   * function that flushes everything pending before the window closes.
   */
  registerFlusher?: (flusher: () => Promise<void>) => void;
}

export function DesktopBootedApp({
  storage,
  repository,
  document,
  registerFlusher,
}: DesktopBootedAppProps) {
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

  useEffect(() => installBootHelpers({ snowdrop, safeMode }), [snowdrop, safeMode]);

  useEffect(() => {
    // Composable with `StorageGate`'s ref: this instance's own flush, plus
    // waiting for the hydrated storage's queued encrypted writes to actually
    // reach disk — `snowdrop.flush()` only enqueues them (bindPersistence
    // writes through `storage.setItem`, which is async under the hood; see
    // hydratedKeyValue.ts). The message repository has no debounced queue of
    // its own to wait on: every write it does is already awaited by its
    // caller before that caller's promise resolves.
    registerFlusher?.(async () => {
      snowdrop.flush();
      await storage.flush();
    });
  }, [snowdrop, storage, registerFlusher]);

  return (
    <SnowdropProvider snowdrop={snowdrop}>
      <App
        onBackendChange={() => {
          void snowdrop.admin.reload();
        }}
      />
    </SnowdropProvider>
  );
}
