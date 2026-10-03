/**
 * Native notifications (tauri-plugin-notification) behind the app's
 * `NotificationApi`. The plugin can't report clicks on desktop, so a
 * notification only informs; the conversation is a click away in the app.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { NotificationApi } from '@/core/services';

type Permission = ReturnType<NotificationApi['permission']>;

export async function tauriNotificationApi(): Promise<NotificationApi> {
  let permission: Permission = (await isPermissionGranted().catch(() => false))
    ? 'granted'
    : 'default';
  return {
    permission: () => permission,
    request: async () => {
      const result = await requestPermission().catch(() => 'denied' as const);
      permission = result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
      return permission;
    },
    show: ({ title, body }) => {
      if (permission !== 'granted') return null;
      try {
        sendNotification({ title, body });
      } catch {
        return null;
      }
      // Desktop notifications can't be withdrawn through the plugin.
      return { close: () => undefined };
    },
  };
}
