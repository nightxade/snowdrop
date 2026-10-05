/**
 * Desktop (Tauri) services for the composition root. The platform module is
 * imported dynamically, and only inside Tauri (`isTauri()`), so the browser
 * build and the tests never load `@tauri-apps/*`.
 */
import type { DesktopAdmin, StorageAdmin } from '@/core/backend';
import type { NotificationApi } from '@/core/services';
import { isTauri } from '@/platform/detect';

export { isTauri };

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
      console.error('[snowdrop] native notifications unavailable', error);
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
      console.error('[snowdrop] failed to register the close handshake', error);
    });
}
