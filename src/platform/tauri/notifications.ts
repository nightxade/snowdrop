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
import { createLogger } from '@/core/lib';
import { tauriIpc, type TauriIpc } from './ipc';

type Permission = ReturnType<NotificationApi['permission']>;

export async function tauriNotificationApi(ipc: TauriIpc = tauriIpc): Promise<NotificationApi> {
  const log = createLogger('notifications');
  const current = new Map<string, object>();
  // Keep show/close order even when IPC or the desktop service is slow.
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch(() => {
      log.warn('Desktop notification failed');
    });
  };
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
    show: ({ title, body, tag }) => {
      if (permission !== 'granted') return null;
      const token = {};
      current.set(tag, token);
      enqueue(async () => {
        if (current.get(tag) !== token) return;
        const handled = await ipc.invoke<boolean>('notification_show', { tag, title, body });
        if (!handled) sendNotification({ title, body });
      });
      return {
        close: () => {
          // NotificationService closes the old handle just before showing its
          // replacement. Defer so that replacement can reuse the native id.
          queueMicrotask(() => {
            if (current.get(tag) !== token) return;
            current.delete(tag);
            enqueue(async () => {
              await ipc.invoke('notification_close', { tag });
            });
          });
        },
      };
    },
  };
}
