import { BellRing, CircleCheck, CircleSlash, Send } from 'lucide-react';
import { useCallback, useReducer, useState, useSyncExternalStore } from 'react';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Segmented, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import type { PageProps } from '../pages';
import styles from './pages.module.css';

type Permission = ReturnType<ReturnType<typeof useSnowdrop>['notifications']['permission']>;

export function NotificationsPage({ onNavigate }: PageProps) {
  const { notifications, desktop } = useSnowdrop();
  const isDesktop = desktop !== null;
  const copy = isDesktop ? DESKTOP_COPY : BROWSER_COPY;
  const [n, set] = useSettingsSection('notifications');
  // The permission lives outside the stores (a system prompt, the platform
  // still loading, the user changing it in system settings): follow the
  // service's word on it, and look again when the window is focused.
  const subscribe = useCallback(
    (listener: () => void) => {
      const stop = notifications.onPermissionChange(listener);
      window.addEventListener('focus', listener);
      return () => {
        stop();
        window.removeEventListener('focus', listener);
      };
    },
    [notifications],
  );
  const permission: Permission = useSyncExternalStore(subscribe, () => notifications.permission());
  const [, reread] = useReducer((n: number) => n + 1, 0);
  const [tested, setTested] = useState<'shown' | 'refused' | 'undelivered' | null>(null);
  const off = !n.enabled;

  return (
    <>
      <SettingsSection>
        <SettingRow
          id="notifications.permission"
          label="Notification permission"
          description={copy.permission[permission]}
          control={
            permission === 'default' ? (
              <Button
                variant="primary"
                icon={<BellRing size={16} />}
                onClick={() => {
                  void notifications.requestPermission().then(reread);
                }}
              >
                Allow notifications
              </Button>
            ) : permission === 'granted' ? (
              <Button
                icon={<Send size={16} />}
                onClick={() => {
                  setTested(null);
                  void notifications.test().then(setTested);
                }}
              >
                Send a test
              </Button>
            ) : undefined
          }
          note={
            permission === 'denied' ? (
              <>
                <CircleSlash size={14} aria-hidden />
                {copy.blocked}
              </>
            ) : tested === 'refused' ? (
              copy.testFailed
            ) : tested === 'undelivered' ? (
              copy.undelivered
            ) : tested === 'shown' ? (
              <>
                <CircleCheck size={14} aria-hidden />
                Sent. If nothing appeared, check your system’s do-not-disturb setting.
              </>
            ) : undefined
          }
          noteTone={
            permission === 'denied'
              ? 'danger'
              : tested === 'refused' || tested === 'undelivered'
                ? 'warning'
                : 'success'
          }
        />
      </SettingsSection>
      <SettingsSection id="when" title="When to notify">
        <SettingRow
          id="notifications.enabled"
          label="Desktop notifications"
          description="Never for the conversation you’re looking at. The bell in your user panel toggles this too."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={n.enabled}
              onCheckedChange={(enabled) => {
                set({ enabled });
              }}
            />
          )}
        />
        <SettingRow
          id="notifications.mode"
          label="Notify me about"
          description={
            n.mode === 'mentions'
              ? 'Groups notify only when someone @mentions you or a keyword alert matches. Direct messages always notify.'
              : n.mode === 'none'
                ? 'Nothing notifies, mentions included. Unread badges still update.'
                : 'Every new message, except in muted conversations and spaces.'
          }
          disabled={off}
          control={(ids) => (
            <Segmented
              labelledBy={ids.labelId}
              label="Notify me about"
              value={n.mode}
              options={[
                { value: 'all', label: 'All messages' },
                { value: 'mentions', label: 'Mentions' },
                { value: 'none', label: 'Nothing' },
              ]}
              onValueChange={(mode) => {
                set({ mode });
              }}
            />
          )}
        />
        <SettingRow
          id="notifications.preview"
          label="Show message text"
          description="Off shows only who wrote, for when others can see your screen. Spoilers are never shown."
          disabled={off}
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={n.showPreview}
              onCheckedChange={(showPreview) => {
                set({ showPreview });
              }}
            />
          )}
        />
        <SettingRow
          id="notifications.mute"
          label="Muting spaces and conversations"
          description="Right-click a space or conversation and choose Mute to silence it (for a while or until you turn it back on). Mentions of you and keyword alerts still come through."
          control={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onNavigate('plugins');
              }}
            >
              Set up keyword alerts
            </Button>
          }
        />
        <SettingRow
          id="notifications.sound"
          label="Sounds"
          description="No sound is played by Snowdrop. Desktop notifications are sent silently; your system decides whether to make a sound for them."
          disabled
        />
      </SettingsSection>
      <p className={styles.muted}>{copy.footer}</p>
    </>
  );
}

interface Copy {
  permission: Record<Permission, string>;
  blocked: string;
  testFailed: string;
  /** The platform call itself failed (the note shows only then). */
  undelivered: string;
  footer: string;
}

const BROWSER_COPY: Copy = {
  permission: {
    default: 'Snowdrop needs your browser’s permission before it can show desktop notifications.',
    granted: 'Allowed. Snowdrop can show desktop notifications.',
    denied: 'Blocked by your browser.',
    unsupported: 'This browser doesn’t support desktop notifications.',
  },
  blocked:
    'Notifications are blocked for this site. Allow them in your browser’s site settings (the icon left of the address bar), then reload Snowdrop.',
  testFailed:
    'Your browser didn’t show the test notification. Check your system’s notification settings.',
  undelivered:
    'Your browser didn’t show the test notification. Check your system’s notification settings.',
  footer: 'Notifications are shown by your browser while Snowdrop is open in a tab.',
};

const DESKTOP_COPY: Copy = {
  permission: {
    default: 'Snowdrop needs your system’s permission before it can show desktop notifications.',
    granted: 'Allowed. Snowdrop can show desktop notifications.',
    denied: 'Blocked by your system.',
    unsupported: 'Desktop notifications aren’t available on this system.',
  },
  blocked:
    'Notifications are blocked for Snowdrop. Allow them in your system’s notification settings, then come back here.',
  testFailed:
    'Your system didn’t show the test notification. Check your system’s notification settings.',
  undelivered: 'No notification service answered. Check that one is running, then try again.',
  footer: 'Notifications are shown by your system while Snowdrop is running.',
};
