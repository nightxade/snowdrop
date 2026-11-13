/**
 * Builds the real Snowdrop instance once encrypted storage is unlocked
 * (`StorageGate`) and renders what `src/main.tsx` renders for the browser
 * build: safe mode (?safe=1), native dev tools in
 * development, and a flush on page hide.
 */
import { createLogger, ignored } from '@/core/lib';
import { useEffect, useState } from 'react';
import type { HydratedKeyValue, MessageRepository } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
import { App } from './App';
import { createSnowdrop, type Snowdrop } from './createSnowdrop';
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

const log = createLogger('app');

/**
 * How long a new instance waits for the previous one's `dispose()`. Past it,
 * the new instance starts anyway (a teardown step that never settles would
 * otherwise leave a blank window with no way out).
 */
const DISPOSE_TIMEOUT_MS = 10_000;

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

  // The previous instance of this app (an unmount followed by a new mount)
  // shares the signal-cli connection, the storage and the tray with this one,
  // and its `dispose()` disconnects and flushes: this instance doesn't start
  // until that has finished. Nothing is pending in the usual case.
  const [ready, setReady] = useState(() => pendingDisposals === 0);

  // Disposed on unmount. React's development double mount runs this cleanup
  // and then the effect again on the same instance, and `dispose()` is final,
  // so the disposal waits a tick and the re-run cancels it.
  useEffect(() => {
    cancelDisposal.get(snowdrop)?.();
    cancelDisposal.delete(snowdrop);
    let current = true;
    void disposalsSettled.then(() => {
      if (current) setReady(true);
    });
    return () => {
      current = false;
      cancelDisposal.set(snowdrop, scheduleDisposal(snowdrop));
    };
  }, [snowdrop]);

  if (!ready) return null;
  return (
    <BootedInstance
      snowdrop={snowdrop}
      safeMode={safeMode}
      storage={storage}
      registerFlusher={registerFlusher}
    />
  );
}

/** Disposals scheduled and not yet finished, and a promise for all of them. */
let pendingDisposals = 0;
let disposalsSettled: Promise<void> = Promise.resolve();
/** Cancels a scheduled disposal that hasn't started (a remount of the same instance). */
const cancelDisposal = new WeakMap<Snowdrop, () => void>();

function scheduleDisposal(snowdrop: Snowdrop): () => void {
  pendingDisposals++;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      resolve();
    };
  });
  let finished = false;
  let fired = false;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    if (finished) return;
    finished = true;
    pendingDisposals--;
    clearTimeout(giveUp);
    finish();
  };
  disposalsSettled = Promise.all([disposalsSettled, done]).then(() => undefined);
  const timer = setTimeout(() => {
    fired = true;
    giveUp = setTimeout(() => {
      log.error(
        `the previous instance did not finish disposing within ${String(DISPOSE_TIMEOUT_MS / 1000)} s; starting anyway`,
      );
      end();
    }, DISPOSE_TIMEOUT_MS);
    snowdrop
      .dispose()
      .catch(ignored('the instance is going away; a failed teardown has nowhere to report'))
      .finally(end);
  }, 0);
  return () => {
    if (fired) return;
    clearTimeout(timer);
    end();
  };
}

function BootedInstance({
  snowdrop,
  safeMode,
  storage,
  registerFlusher,
}: {
  snowdrop: Snowdrop;
  safeMode: boolean;
  storage: HydratedKeyValue;
  registerFlusher: DesktopBootedAppProps['registerFlusher'];
}) {
  useEffect(() => installBootHelpers({ snowdrop, safeMode }), [snowdrop, safeMode]);

  useEffect(() => {
    // Composable with `StorageGate`'s ref: this instance's own flush, plus
    // waiting for the hydrated storage's queued encrypted writes to actually
    // reach disk — `snowdrop.flush()` only enqueues them (bindPersistence
    // writes through `storage.setItem`, which is async under the hood; see
    // hydratedKeyValue.ts) — and for the message repository's queued writes
    // (a message still being encrypted when the window closes). The caller's
    // exit budget bounds the wait.
    registerFlusher?.(async () => {
      // Quitting: stop waiting on slow requests and let an aborted send record
      // "may have sent" (briefly), so that write is in the flush below.
      await snowdrop.abortInFlight();
      snowdrop.flush();
      await Promise.all([
        storage.flush(),
        snowdrop.repository
          .flush()
          .catch(ignored('the exit flush is best effort; the exit budget bounds the wait')),
      ]);
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
