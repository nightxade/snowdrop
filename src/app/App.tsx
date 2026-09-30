import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { BackendChoice } from '@/core/stores';
import { Welcome } from '@/ui/features/onboarding';
import { AppShell } from '@/ui/features/shell';
import type { Hearth } from './createHearth';
import { useHearth } from './HearthProvider';

const started = new WeakSet<Hearth>();

/** Starts a Hearth instance once, whatever StrictMode does to effects. */
export function startOnce(hearth: Hearth): void {
  if (started.has(hearth)) return;
  started.add(hearth);
  hearth.start().catch((error: unknown) => {
    // The session store carries the error; the shell shows it with a retry.
    console.error('[hearth] failed to start', error);
  });
}

export interface AppProps {
  /**
   * Called when the chosen backend differs from the running instance's
   * (createHearth picks the transport once). The browser entry reloads.
   */
  onBackendChange?: () => void;
}

/** First run shows the welcome screen; afterwards the shell boots straight into the chosen backend. */
export function App({ onBackendChange }: AppProps) {
  const hearth = useHearth();
  const choice = useStore(hearth.stores.settings, (s) => s.connection.backend);
  const daemonUrl = useStore(hearth.stores.settings, (s) => s.connection.daemonUrl);
  const matches = choice !== null && choice === hearth.backend.kind;

  useEffect(() => {
    if (choice === null) return;
    if (matches) startOnce(hearth);
    else onBackendChange?.();
  }, [choice, matches, hearth, onBackendChange]);

  if (choice === null) {
    const choose = (backend: BackendChoice, url?: string) => {
      hearth.stores.settings
        .getState()
        .update('connection', { backend, ...(url !== undefined ? { daemonUrl: url } : {}) });
      // Persist before a possible reload.
      hearth.flush();
    };
    return (
      <Welcome
        defaultDaemonUrl={daemonUrl}
        onDemo={() => {
          choose('mock');
        }}
        onConnect={(url) => {
          choose('signal-cli', url);
        }}
      />
    );
  }
  return <AppShell />;
}
