import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App,
  AppErrorBoundary,
  createSnowdrop,
  desktopStorageAdmin,
  DesktopBootedApp,
  installBootHelpers,
  installTerminalErrorLog,
  isTauri,
  SnowdropProvider,
  StorageGate,
} from '@/app';
import { markStartup } from '@/core/lib';
import '@/ui/styles/global.css';

markStartup('bundle evaluated');

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// A no-op: without it, React additionally logs every error AppErrorBoundary
// catches via its own default (console.error), double-reporting it next to
// `report`'s explicit call in AppErrorBoundary.componentDidCatch below.
const onCaughtError = () => {};

if (isTauri()) {
  // The desktop app's data is encrypted at rest (docs/ENCRYPTION.md):
  // `StorageGate` owns everything that has to happen before a Snowdrop
  // instance — needing setup, locked, or unavailable — can even exist.
  const report = installTerminalErrorLog();
  createRoot(container, {
    onUncaughtError: (error, info) => {
      report(error, `uncaught render error${info.componentStack ?? ''}`);
    },
    onCaughtError,
  }).render(
    <StrictMode>
      <AppErrorBoundary report={report}>
        <StorageGate admin={desktopStorageAdmin()} document={document}>
          {({ storage, repository }, registerFlusher) => (
            <DesktopBootedApp
              storage={storage}
              repository={repository}
              document={document}
              registerFlusher={registerFlusher}
            />
          )}
        </StorageGate>
      </AppErrorBoundary>
    </StrictMode>,
  );
} else {
  bootBrowser(container);
}

/**
 * Themes apply immediately (the welcome screen is themed too); connecting
 * waits until a backend has been chosen, which <App> handles.
 * Safe mode (?safe=1): imported themes and Custom CSS are skipped, so a theme
 * that breaks the UI can always be removed.
 *
 * Browser/dev/mock mode only: there's no vault, so storage stays exactly as
 * it was before encrypted storage existed (plaintext, via the defaults
 * `createSnowdrop` already falls back to).
 *
 * `?mockLatencyMs=`/`?mockBulkMessages=`: scroll-performance harness knobs
 * for local testing, unused otherwise — they stand in for the desktop's IPC
 * latency and a long local history so scrolling through thousands of
 * messages is reproducible without a real signal-cli account.
 */
function bootBrowser(container: HTMLElement): void {
  const params = new URLSearchParams(window.location.search);
  const safeMode = params.get('safe') === '1';
  const mockLatencyMs = intParam(params, 'mockLatencyMs');
  const mockBulkMessages = intParam(params, 'mockBulkMessages');
  const snowdrop = createSnowdrop({
    document,
    safeMode,
    ...(mockLatencyMs === undefined ? {} : { mockLatencyMs }),
    ...(mockBulkMessages === undefined ? {} : { mockBulkMessages }),
  });
  // Never unmounts, so the cleanup function (removed listeners) is never
  // needed here — it matters for DesktopBootedApp, which can re-run this
  // per instance.
  installBootHelpers({ snowdrop, safeMode });

  // A no-op reporter outside Tauri (nothing to send to a terminal), but
  // AppErrorBoundary still wraps the tree so a render error doesn't blank
  // the window here either.
  const report = installTerminalErrorLog();

  createRoot(container, { onCaughtError }).render(
    <StrictMode>
      <AppErrorBoundary report={report}>
        <SnowdropProvider snowdrop={snowdrop}>
          <App
            onBackendChange={() => {
              // createSnowdrop picks the transport once; a new choice needs a fresh instance.
              void snowdrop.admin.reload();
            }}
          />
        </SnowdropProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}

/** A positive-integer query param, or undefined if absent/invalid. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
