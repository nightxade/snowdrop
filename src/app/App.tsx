import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { BackendChoice } from '@/core/stores';
import { ConnectionSetup, Welcome } from '@/ui/features/onboarding';
import { AppShell } from '@/ui/features/shell';
import type { Shrike } from './createShrike';
import { useShrike } from './ShrikeProvider';

const started = new WeakSet<Shrike>();

/** Starts a Shrike instance once, whatever StrictMode does to effects. */
export function startOnce(shrike: Shrike): void {
  if (started.has(shrike)) return;
  started.add(shrike);
  shrike.start().catch((error: unknown) => {
    // The session store carries the error; the shell shows it with a retry.
    console.error('[shrike] failed to start', error);
  });
}

export interface AppProps {
  /**
   * Called when the chosen backend differs from the running instance's
   * (createShrike picks the transport once). The browser entry reloads.
   */
  onBackendChange?: () => void;
}

/** First run shows the welcome screen; afterwards the shell boots straight into the chosen backend. */
export function App({ onBackendChange }: AppProps) {
  const shrike = useShrike();
  const choice = useStore(shrike.stores.settings, (s) => s.connection.backend);
  const daemonUrl = useStore(shrike.stores.settings, (s) => s.connection.daemonUrl);
  const matches = choice !== null && choice === shrike.backend.kind;
  const errorKind = useStore(shrike.stores.session, (s) => s.errorKind);
  const ready = useStore(shrike.stores.session, (s) => s.ready);

  useEffect(() => {
    if (choice === null) return;
    if (matches) startOnce(shrike);
    else onBackendChange?.();
  }, [choice, matches, shrike, onBackendChange]);

  if (choice === null) {
    const choose = (backend: BackendChoice, url?: string) => {
      shrike.stores.settings
        .getState()
        .update('connection', { backend, ...(url !== undefined ? { daemonUrl: url } : {}) });
      // Persist before a possible reload.
      shrike.flush();
    };
    return (
      <Welcome
        defaultDaemonUrl={daemonUrl}
        probe={(url) => shrike.admin.probeDaemon(url)}
        onDemo={() => {
          choose('mock');
        }}
        onConnect={(url) => {
          choose('signal-cli', url);
        }}
      />
    );
  }
  // signal-cli without a usable account: link this device, or name the account (PLAN §4.10).
  if (
    matches &&
    !ready &&
    shrike.backend.kind === 'signal-cli' &&
    (errorKind === 'no-account' || errorKind === 'account-required')
  ) {
    return (
      <ConnectionSetup
        reason={errorKind}
        link={shrike.backend.link}
        onLinked={() => {
          // The adapter now knows the account; retry the start that failed.
          shrike.start().catch((error: unknown) => {
            console.error('[shrike] failed to start after linking', error);
          });
        }}
        onAccount={(account) => {
          shrike.stores.settings.getState().update('connection', { account });
          // The adapter reads the account once, at construction.
          shrike.flush();
          onBackendChange?.();
        }}
        onBack={() => {
          shrike.stores.settings.getState().update('connection', { backend: null });
          shrike.flush();
        }}
      />
    );
  }
  return <AppShell />;
}
