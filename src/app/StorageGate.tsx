/**
 * Boots the desktop app behind encrypted storage (docs/ENCRYPTION.md, "UX").
 * The one state machine for "what do we show before the vault is open":
 * `StorageStatus.state` picks the screen, and every screen only ever reports
 * a fresh `StorageStatus` back up — this is the only place that decides what
 * that means. Nothing else should branch on storage state.
 */
import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { fromBase64, webCryptoCipher } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
// Imported by file, not the onboarding barrel: the barrel also re-exports
// Welcome/ConnectionSetup/LinkDevice, which App.tsx loads lazily — a static
// import of the barrel here would pull all of it into the main bundle.
import { OnboardingShell } from '@/ui/features/onboarding/OnboardingShell';
import { RestartRequiredScreen } from '@/ui/features/onboarding/RestartRequiredScreen';
import setupStyles from '@/ui/features/onboarding/Setup.module.css';
import { StorageSetup } from '@/ui/features/onboarding/StorageSetup';
import storageStyles from '@/ui/features/onboarding/Storage.module.css';
import { StorageUnavailable } from '@/ui/features/onboarding/StorageUnavailable';
import { UnlockScreen } from '@/ui/features/onboarding/UnlockScreen';
import { Button } from '@/ui/primitives';
import { applyBootAppearance } from './bootAppearance';
import { createPersistence, discardUnreadableWebCache, type Persistence } from './persistence';
import { installFlushBeforeClose } from './platform';

/** A no-op until `DesktopBootedApp` registers the real one (nothing to flush yet). */
const NOOP_FLUSHER = () => Promise.resolve();

export interface StorageGateProps {
  admin: StorageAdmin;
  document?: ThemeDocument;
  /**
   * Rendered once storage is unlocked and the encrypted persistence layer is
   * ready. `registerFlusher` lets the booted app plug into the close
   * handshake this gate registers once, for every screen (docs/ENCRYPTION.md,
   * "Close handshake"): call it with a function that flushes everything
   * pending before the window closes.
   */
  children: (
    persistence: Persistence,
    registerFlusher: (flusher: () => Promise<void>) => void,
  ) => ReactNode;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'blocked'; status: StorageStatus }
  | { kind: 'booting' }
  | { kind: 'ready'; persistence: Persistence }
  | { kind: 'failed'; message: string };

export function StorageGate({ admin, document, children }: StorageGateProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const booting = useRef(false);
  // Composable indirection (task: "the gate holds a ref to the current
  // 'flusher' that DesktopBootedApp registers"). `registerFlusher` — handed
  // to `children(...)` during render — only ever calls `setFlusher` (plain
  // `useState` dispatch, never a ref, so passing it along during render is
  // fine). A ref mirrors that state for the close-handshake effect below to
  // read the latest value without re-subscribing on every change; the ref is
  // only ever written from an effect and read from an event handler, never
  // during render.
  const [flusherState, setFlusher] = useState<() => Promise<void>>(() => NOOP_FLUSHER);
  // Only touched by the 'failed' screen's "Try again" button, to disable it
  // while a fresh `admin.status()` round-trip is in flight.
  const [retryingAfterFailure, setRetryingAfterFailure] = useState(false);
  const flusherRef = useRef(flusherState);
  useEffect(() => {
    flusherRef.current = flusherState;
  }, [flusherState]);
  const registerFlusher = useCallback((fn: () => Promise<void>) => {
    setFlusher(() => fn);
  }, []);

  const boot = () => {
    if (booting.current) return;
    booting.current = true;
    setPhase({ kind: 'booting' });
    void admin
      .webcacheKey()
      .then((keyBase64) => webCryptoCipher(fromBase64(keyBase64)))
      .then((cipher) => createPersistence({ cipher }))
      .then((persistence) => {
        setPhase({ kind: 'ready', persistence });
      })
      .catch((error: unknown) => {
        booting.current = false;
        console.error('[snowdrop] failed to open encrypted storage', error);
        setPhase({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const route = (status: StorageStatus) => {
    // A restart is owed (an erase ran in this process): nothing else about
    // `state` matters until that happens — not even the needsSetup cache
    // discard below, since storage refuses every other command anyway.
    if (status.restartRequired) {
      setPhase({ kind: 'blocked', status });
    } else if (status.state === 'unlocked') boot();
    else if (status.state === 'needsSetup') {
      // No key exists, so any encrypted web cache left behind is unreadable.
      void discardUnreadableWebCache().finally(() => {
        setPhase({ kind: 'blocked', status });
      });
    } else setPhase({ kind: 'blocked', status });
  };

  // A status query that itself fails (the IPC rejected) lands on the same
  // "Try again" screen as a failed boot, rather than hanging on "Checking…".
  const checkStatus = () =>
    admin
      .status()
      .then(route)
      .catch((error: unknown) => {
        console.error('[snowdrop] failed to query encrypted storage', error);
        setPhase({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });

  useEffect(() => {
    if (document) applyBootAppearance(document);
    void checkStatus();
    // Intentionally runs once: every later transition comes from a screen
    // calling `route` with a fresh status, not from re-polling here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Registered once, here, so it's active on every screen this gate can
    // show — onboarding and locked included, where there's nothing to flush
    // yet and the no-op resolves immediately — not just once a Snowdrop
    // instance exists (docs/ENCRYPTION.md, "Close handshake"). A no-op in the
    // browser build (`installFlushBeforeClose` checks `isTauri()` itself).
    installFlushBeforeClose(() => flusherRef.current());
  }, []);

  if (phase.kind === 'ready') return <>{children(phase.persistence, registerFlusher)}</>;

  if (phase.kind === 'checking' || phase.kind === 'booting') {
    return (
      <OnboardingShell>
        <div className={storageStyles.checking} aria-busy="true" aria-live="polite">
          <LoaderCircle className={storageStyles.spin} size={28} aria-hidden />
        </div>
      </OnboardingShell>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <OnboardingShell>
        <section className={setupStyles.card} aria-labelledby="storage-failed-title">
          <h2 id="storage-failed-title" className={setupStyles.title}>
            Snowdrop couldn&rsquo;t open its encrypted storage
          </h2>
          <p className={setupStyles.lede} role="alert">
            Something went wrong while opening local storage. Try again — if it keeps happening,
            restarting Snowdrop may help.
          </p>
          <details className={storageStyles.disclosure}>
            <summary>Details</summary>
            <p>{phase.message}</p>
          </details>
          <div className={setupStyles.actions}>
            <Button
              type="button"
              variant="primary"
              autoFocus
              disabled={retryingAfterFailure}
              onClick={() => {
                setRetryingAfterFailure(true);
                void checkStatus().finally(() => {
                  setRetryingAfterFailure(false);
                });
              }}
            >
              Try again
            </Button>
          </div>
        </section>
      </OnboardingShell>
    );
  }

  const { status } = phase;
  if (status.restartRequired) {
    return <RestartRequiredScreen onRestart={() => admin.restart()} />;
  }
  if (status.state === 'needsSetup') {
    return <StorageSetup status={status} admin={admin} onDone={route} />;
  }
  if (status.state === 'locked') {
    return <UnlockScreen status={status} admin={admin} onStatusChange={route} />;
  }
  return <StorageUnavailable reason={status.reason} onRetry={checkStatus} />;
}
