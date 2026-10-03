/**
 * Desktop (Tauri) services for the composition root. The platform module is
 * imported dynamically, and only inside Tauri (`isTauri()`), so the browser
 * build and the tests never load `@tauri-apps/*`.
 */
import type { DesktopAdmin } from '@/core/backend';
import type { NotificationApi } from '@/core/services';
import { isTauri } from '@/platform/detect';

export { isTauri };

const platform = () => import('@/platform/tauri');

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
