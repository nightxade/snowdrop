import { lazy, Suspense, useEffect } from 'react';
import { useStore } from 'zustand';
import type { BackendKind } from '@/core/backend';
import { createLogger } from '@/core/lib';
import { wasConnectionErrorReported } from '@/core/services';
import { sessionSelectors } from '@/core/stores';
// Onboarding is seen once (or on connection trouble): keep it out of the main chunk.
const Welcome = lazy(() =>
  import('@/ui/features/onboarding').then((m) => ({ default: m.Welcome })),
);
const ConnectionSetup = lazy(() =>
  import('@/ui/features/onboarding').then((m) => ({ default: m.ConnectionSetup })),
);
import { AppShell } from '@/ui/features/shell';
import { friendlyAppError } from '@/ui/lib/connectionErrors';
import type { Snowdrop } from './createSnowdrop';
import { screenFor, setupReasonFor } from './routing';
import { useSnowdrop } from './SnowdropProvider';

const log = createLogger('app');
const started = new WeakSet<Snowdrop>();

/** Starts a Snowdrop instance once, whatever StrictMode does to effects. */
export function startOnce(snowdrop: Snowdrop): void {
  if (started.has(snowdrop)) return;
  started.add(snowdrop);
  snowdrop.start().catch((error: unknown) => {
    // The session store carries the error; the shell shows it with a retry.
    // A connect/initial-sync failure was already logged once, at the right
    // level, by SyncService itself (see `wasConnectionErrorReported`) —
    // logging it again here would triplicate it.
    if (!wasConnectionErrorReported(error)) log.error('failed to start', error);
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
  const savedChoice = useStore(snowdrop.stores.settings, (s) => s.connection.backend);
  // A sign-out clears the saved choice before it finishes; keep showing the
  // running backend until the process restarts so its dialog stays up.
  const signingOut = useStore(snowdrop.stores.ui, (s) => s.signingOut);
  const choice = signingOut ? snowdrop.backend.kind : savedChoice;
  const daemonUrl = useStore(snowdrop.stores.settings, (s) => s.connection.daemonUrl);
  const matches = choice !== null && choice === snowdrop.backend.kind;
  const phase = useStore(snowdrop.stores.session, sessionSelectors.phase);
  const sessionError = useStore(snowdrop.stores.session, sessionSelectors.error);
  const desktopBinaryPath = useStore(
    snowdrop.stores.settings,
    (s) => s.connection.desktop.binaryPath,
  );

  useEffect(() => {
    if (choice === null) return;
    if (matches) startOnce(snowdrop);
    else onBackendChange?.();
  }, [choice, matches, snowdrop, onBackendChange]);

  const screen = screenFor(phase, {
    chosen: choice !== null,
    matches,
    backend: snowdrop.backend.kind,
    desktop: snowdrop.desktop !== null,
  });
  const setupReason = setupReasonFor(phase, snowdrop.desktop !== null);

  if (screen === 'welcome') {
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
  if (screen === 'connection-setup' && setupReason !== null) {
    return (
      <Suspense fallback={null}>
        <ConnectionSetup
          reason={setupReason}
          desktop={snowdrop.desktop !== null}
          errorMessage={friendlyAppError(sessionError)}
          onProgramPath={(binaryPath) => {
            const { connection } = snowdrop.stores.settings.getState();
            snowdrop.stores.settings.getState().update('connection', {
              desktop: { ...connection.desktop, binaryPath },
            });
            snowdrop.flush();
            onBackendChange?.();
          }}
          install={
            snowdrop.desktop
              ? {
                  admin: snowdrop.desktop,
                  // A custom path the user set is the "bad path" case
                  // (MissingSignalCli); nothing configured means first run.
                  configured: desktopBinaryPath.trim() !== '',
                  onInstalled: () => {
                    snowdrop.start().catch((error: unknown) => {
                      if (!wasConnectionErrorReported(error)) {
                        log.error('failed to start after installing signal-cli', error);
                      }
                    });
                  },
                }
              : undefined
          }
          link={snowdrop.backend.link}
          onLinked={() => {
            // The adapter now knows the account; retry the start that failed.
            snowdrop.start().catch((error: unknown) => {
              if (!wasConnectionErrorReported(error)) {
                log.error('failed to start after linking', error);
              }
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
