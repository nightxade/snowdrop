/**
 * Desktop (Tauri) services for the composition root. The platform module is
 * imported dynamically, and only inside Tauri (`isTauri()`), so the browser
 * build and the tests never load `@tauri-apps/*`.
 */
import type { DesktopAdmin, StorageAdmin } from '@/core/backend';
import { addLogSink, createLogger, type LogAdmin } from '@/core/lib';
import type { NotificationApi } from '@/core/services';
import { isTauri } from '@/platform/detect';
import type { LastIpcCommand } from '@/platform/tauri';

export { isTauri };
export type { LastIpcCommand };

// Cached: several callers (desktop admin, storage admin, notifications,
// external links) each reach for this module, and it must resolve to the
// exact same module object for all of them — including under `vi.mock`,
// which replaces the module for one underlying `import()` call, not
// necessarily for every call site that happens to share a specifier.
const importPlatform = () => import('@/platform/tauri');
let platformModule: ReturnType<typeof importPlatform> | null = null;
const platform = () => (platformModule ??= importPlatform());

/**
 * Encrypted storage (docs/ENCRYPTION.md): lazily wraps the real
 * `StorageAdmin` so `StorageGate` can call it before anything else in the
 * desktop app has loaded, without this module (or the browser build) ever
 * loading `@tauri-apps/*` directly.
 */
export function desktopStorageAdmin(): StorageAdmin {
  const admin = platform().then((m) => m.createStorageAdmin());
  // A second handler, so a rejection (the module failed to load, or a test
  // mocks @/platform/tauri without createStorageAdmin because it's testing
  // something unrelated) never becomes an unhandled rejection just from
  // constructing this object. Every method below awaits `admin` itself and
  // surfaces the same failure to its actual caller.
  admin.catch(() => {});
  return {
    status: async () => (await admin).status(),
    keyringStatus: async () => (await admin).keyringStatus(),
    setup: async (mode, passphrase) => (await admin).setup(mode, passphrase),
    unlock: async (method, secret, remember) => (await admin).unlock(method, secret, remember),
    createRecovery: async () => (await admin).createRecovery(),
    removeRecovery: async () => (await admin).removeRecovery(),
    setPassphrase: async (passphrase) => (await admin).setPassphrase(passphrase),
    enrollKeyring: async () => (await admin).enrollKeyring(),
    webcacheKey: async () => (await admin).webcacheKey(),
    eraseAll: async () => (await admin).eraseAll(),
    signOut: async () => (await admin).signOut(),
    restart: async () => (await admin).restart(),
  };
}

/** Native notifications; `permission()` reads "default" until the plugin has answered. */
export function desktopNotificationApi(): NotificationApi {
  let api: NotificationApi | null = null;
  const loading = platform()
    .then((m) => m.tauriNotificationApi())
    .then((loaded) => {
      api = loaded;
    })
    .catch((error: unknown) => {
      createLogger('app').error('native notifications unavailable', error);
    });
  return {
    permission: () => api?.permission() ?? 'default',
    request: async () => {
      await loading;
      return api ? api.request() : 'unsupported';
    },
    show: (content, onClick) => api?.show(content, onClick) ?? null,
  };
}

/**
 * The most recently started real IPC command, for the main-thread stall
 * detector (`src/app/perf.ts`) to report as context. Best-effort: until
 * `@/platform/tauri` has actually finished loading (normally already true
 * by the time the UI is interactive, since several other desktop services
 * above trigger it at boot), this returns null rather than waiting — a
 * missing command in one stall's log line is a fine trade for never
 * blocking on it. Always null outside Tauri, where there's no IPC at all.
 */
let ipcDiagnostics: Pick<Awaited<ReturnType<typeof importPlatform>>, 'getLastIpcCommand'> | null =
  null;
export function desktopLastIpcCommand(): LastIpcCommand | null {
  if (!isTauri()) return null;
  if (!ipcDiagnostics) {
    void platform()
      .then((m) => {
        ipcDiagnostics = m;
      })
      .catch(() => {});
    return null;
  }
  return ipcDiagnostics.getLastIpcCommand();
}

export function desktopAdmin(): DesktopAdmin {
  const admin = platform().then((m) => m.createDesktopAdmin());
  // See desktopStorageAdmin's matching guard just above.
  admin.catch(() => {});
  return {
    probe: async (desktop) => (await admin).probe(desktop),
    locate: async (desktop) => (await admin).locate(desktop),
    info: async () => (await admin).info(),
    pinnedRelease: async () => (await admin).pinnedRelease(),
    installStatus: async () => (await admin).installStatus(),
    install: async (onProgress) => (await admin).install(onProgress),
    cancelInstall: async () => (await admin).cancelInstall(),
  };
}

/** Web links open in the system browser instead of navigating the app. */
export function installDesktopLinks(): void {
  void platform().then((m) => m.installExternalLinks());
}

/**
 * The close handshake (docs/ENCRYPTION.md, "Close handshake"): lazily wires
 * up `onFlushBeforeClose` the same way the other desktop services above do,
 * so `StorageGate` (the one caller) never has to load `@tauri-apps/*`
 * directly. A no-op in the browser build, where there's no close handshake
 * to answer.
 */
export function installFlushBeforeClose(handler: () => Promise<void>): void {
  if (!isTauri()) return;
  void platform()
    .then((m) => m.onFlushBeforeClose(handler))
    .catch((error: unknown) => {
      createLogger('app').error('failed to register the close handshake', error);
    });
}

/**
 * Whether the desktop app's own log floor is currently raised to Debug
 * (Settings → Data & storage → Diagnostics → "Verbose logging"). Read by
 * the Tauri sink below, so info/debug lines don't make the IPC round trip
 * at all when nobody's asked for them — Rust would drop them anyway
 * (`log_set_verbose` raises the same floor on that side).
 */
let verboseLogging = false;
let desktopLogSinkInstalled = false;

/**
 * Routes the scoped logger's lines (`src/core/lib/log.ts`) to the desktop
 * app's own log via `frontend_log`: warn/error always, info/debug only
 * while verbose logging is on. Installed once, unconditionally (a no-op
 * outside Tauri) — so logging reaches the terminal/log file even for
 * errors that happen before a Snowdrop instance exists.
 */
function installDesktopLogSink(): void {
  if (!isTauri() || desktopLogSinkInstalled) return;
  desktopLogSinkInstalled = true;
  addLogSink({
    write: (level, scope, message) => {
      if ((level === 'info' || level === 'debug') && !verboseLogging) return;
      void platform()
        .then((m) => {
          m.sendFrontendLog(level, scope, message);
        })
        .catch(() => {});
    },
  });
}

/**
 * Settings → Data & storage → Diagnostics (desktop only; null in the
 * browser build via `AppServices.logs`). `setVerbose` updates both the
 * Rust-side floor and this module's own gating flag above, so the sink's
 * behaviour follows it immediately — `createSnowdrop` calls it once at
 * boot with the persisted setting, and again whenever
 * `behaviour.verboseLogging` changes (including from the Diagnostics
 * switch, which just updates that setting).
 */
export function desktopLogAdmin(): LogAdmin {
  return {
    recent: (maxBytes) =>
      platform()
        .then((m) => m.logRecent(maxBytes))
        .catch(() => ''),
    setVerbose: (verbose) => {
      verboseLogging = verbose;
      return platform()
        .then((m) => m.logSetVerbose(verbose))
        .catch(() => {});
    },
    openFolder: () => {
      void platform()
        .then((m) => m.logOpenFolder())
        .catch(() => {});
    },
  };
}

/**
 * Desktop and browser alike: an uncaught window error, an unhandled
 * rejection, or (via the returned reporter) a caught render error is logged
 * at scope `app` — console always (dev visibility), the desktop sink too
 * once `installDesktopLogSink` has registered it, so a blank window run
 * from a terminal still says what failed. Returns the reporter for React's
 * root error callbacks (`main.tsx`, `AppErrorBoundary`).
 */
export function installTerminalErrorLog(): (error: unknown, where: string) => void {
  installDesktopLogSink();
  const log = createLogger('app');
  const report = (error: unknown, where: string): void => {
    log.error(where, error);
  };
  window.addEventListener('error', (event) => {
    report(event.error ?? event.message, 'uncaught error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    report(event.reason, 'unhandled rejection');
  });
  return report;
}

/** Native formats absent from WebKit's ClipboardEvent (Linux screenshots and file-manager copies). */
export async function desktopClipboardFiles(): Promise<File[]> {
  return (await platform()).readClipboardFiles();
}
