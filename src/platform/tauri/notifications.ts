/**
 * Native notifications (tauri-plugin-notification) behind the app's
 * `NotificationApi`. The plugin itself can't report clicks on desktop
 * (`tauri-plugin-notification`'s desktop backend only ever uses title,
 * body, icon and sound — see its own doc comment); Linux's notifications
 * instead go through `notification_show` (src-tauri/src/notifications.rs),
 * whose background click listener emits `EVENT_NOTIFICATION_CLICKED` with
 * the clicked notification's `tag`. Elsewhere (macOS, Windows) a
 * notification still only informs — see docs/DESKTOP.md.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { NotificationApi } from '@/core/services';
import { createLogger } from '@/core/lib';
import { tauriIpc, type TauriIpc } from './ipc';

/** Rust side: src-tauri/src/lib.rs. Payload is the clicked tag, verbatim. */
export const EVENT_NOTIFICATION_CLICKED = 'snowdrop://notification-clicked';

type Permission = ReturnType<NotificationApi['permission']>;

export async function tauriNotificationApi(ipc: TauriIpc = tauriIpc): Promise<NotificationApi> {
  const log = createLogger('notifications');
  const current = new Map<string, { token: object; onClick: () => void }>();
  // Keep show/close order even when IPC or the desktop service is slow.
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch(() => {
      log.warn('Desktop notification failed');
    });
  };
  // One listener for every notification this module shows, regardless of
  // platform — a no-op everywhere the event never fires (see module doc).
  try {
    await ipc.listen<string>(EVENT_NOTIFICATION_CLICKED, (tag) => {
      current.get(tag)?.onClick();
    });
  } catch {
    log.warn('Could not listen for notification clicks');
  }
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
    show: ({ title, body, tag }, onClick) => {
      if (permission !== 'granted') return null;
      const token = {};
      current.set(tag, { token, onClick });
      enqueue(async () => {
        if (current.get(tag)?.token !== token) return;
        const handled = await ipc.invoke<boolean>('notification_show', { tag, title, body });
        if (!handled) sendNotification({ title, body });
      });
      return {
        close: () => {
          // NotificationService closes the old handle just before showing its
          // replacement. Defer so that replacement can reuse the native id.
          queueMicrotask(() => {
            if (current.get(tag)?.token !== token) return;
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
