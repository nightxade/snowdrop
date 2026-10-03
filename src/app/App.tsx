import { lazy, Suspense, useEffect } from 'react';
import { useStore } from 'zustand';
import type { BackendKind } from '@/core/backend';
// Onboarding is seen once (or on connection trouble): keep it out of the main chunk.
const Welcome = lazy(() =>
  import('@/ui/features/onboarding').then((m) => ({ default: m.Welcome })),
);
const ConnectionSetup = lazy(() =>
  import('@/ui/features/onboarding').then((m) => ({ default: m.ConnectionSetup })),
);
import { AppShell } from '@/ui/features/shell';
import type { Snowdrop } from './createSnowdrop';
import { useSnowdrop } from './SnowdropProvider';

const started = new WeakSet<Snowdrop>();

/** Starts a Snowdrop instance once, whatever StrictMode does to effects. */
export function startOnce(snowdrop: Snowdrop): void {
  if (started.has(snowdrop)) return;
  started.add(snowdrop);
  snowdrop.start().catch((error: unknown) => {
    // The session store carries the error; the shell shows it with a retry.
    console.error('[snowdrop] failed to start', error);
  });
}

export interface AppProps {
  /**
   * Called when the chosen backend differs from the running instance's
   * (createSnowdrop picks the transport once). The browser entry reloads.
   */
  onBackendChange?: () => void;
}

/** First run shows the welcome screen; afterwards the shell boots straight into the chosen backend. */
export function App({ onBackendChange }: AppProps) {
  const snowdrop = useSnowdrop();
  const choice = useStore(snowdrop.stores.settings, (s) => s.connection.backend);
  const daemonUrl = useStore(snowdrop.stores.settings, (s) => s.connection.daemonUrl);
  const matches = choice !== null && choice === snowdrop.backend.kind;
  const errorKind = useStore(snowdrop.stores.session, (s) => s.errorKind);
  const errorMessage = useStore(snowdrop.stores.session, (s) => s.error);
  const ready = useStore(snowdrop.stores.session, (s) => s.ready);

  useEffect(() => {
    if (choice === null) return;
    if (matches) startOnce(snowdrop);
    else onBackendChange?.();
  }, [choice, matches, snowdrop, onBackendChange]);

  if (choice === null) {
    const choose = (backend: BackendKind, url?: string) => {
      snowdrop.stores.settings
        .getState()
        .update('connection', { backend, ...(url !== undefined ? { daemonUrl: url } : {}) });
      // Persist before a possible reload.
      snowdrop.flush();
    };
    return (
      <Suspense fallback={null}>
        <Welcome
          desktop={snowdrop.desktop !== null}
          defaultDaemonUrl={daemonUrl}
          probe={(url) => snowdrop.admin.probeDaemon(url)}
          onDemo={() => {
            choose('mock');
          }}
          onConnect={(url) => {
            // The desktop app runs signal-cli itself: its connection settings already hold the defaults.
            choose('signal-cli', snowdrop.desktop ? undefined : url);
          }}
        />
      </Suspense>
    );
  }
  // signal-cli without a usable account: link this device, or name the account (PLAN §4.10).
  // In the desktop app, also: no signal-cli program to run.
  if (
    matches &&
    !ready &&
    snowdrop.backend.kind === 'signal-cli' &&
    (errorKind === 'no-account' ||
      errorKind === 'account-required' ||
      (snowdrop.desktop && errorKind === 'not-installed'))
  ) {
    return (
      <Suspense fallback={null}>
        <ConnectionSetup
          reason={errorKind}
          errorMessage={errorMessage}
          onProgramPath={(binaryPath) => {
            const { connection } = snowdrop.stores.settings.getState();
            snowdrop.stores.settings.getState().update('connection', {
              desktop: { ...connection.desktop, binaryPath, useBundled: false },
            });
            snowdrop.flush();
            onBackendChange?.();
          }}
          link={snowdrop.backend.link}
          onLinked={() => {
            // The adapter now knows the account; retry the start that failed.
            snowdrop.start().catch((error: unknown) => {
              console.error('[snowdrop] failed to start after linking', error);
            });
          }}
          onAccount={(account) => {
            snowdrop.stores.settings.getState().update('connection', { account });
            // The adapter reads the account once, at construction.
            snowdrop.flush();
            onBackendChange?.();
          }}
          onBack={() => {
            snowdrop.stores.settings.getState().update('connection', { backend: null });
            snowdrop.flush();
          }}
        />
      </Suspense>
    );
  }
  return <AppShell />;
}
