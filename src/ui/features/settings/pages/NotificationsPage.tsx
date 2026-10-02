import { BellRing, CircleCheck, CircleSlash, Send } from 'lucide-react';
import { useState } from 'react';
import { useShrike } from '@/ui/hooks';
import { Button, Segmented, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import styles from './pages.module.css';

type Permission = ReturnType<ReturnType<typeof useShrike>['notifications']['permission']>;

export function NotificationsPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { notifications } = useShrike();
  const [n, set] = useSettingsSection('notifications');
  // Permission changes come from a browser prompt, not a store: re-read after acting.
  const [permission, setPermission] = useState<Permission>(() => notifications.permission());
  const [tested, setTested] = useState<boolean | null>(null);
  const off = !n.enabled;

  return (
    <>
      <SettingsSection>
        <SettingRow
          id="notifications.permission"
          label="Browser permission"
          description={PERMISSION_TEXT[permission]}
          control={
            permission === 'default' ? (
              <Button
                variant="primary"
                icon={<BellRing size={16} />}
                onClick={() => {
                  void notifications.requestPermission().then(setPermission);
                }}
              >
                Allow notifications
              </Button>
            ) : permission === 'granted' ? (
              <Button
                icon={<Send size={16} />}
                onClick={() => {
                  setTested(notifications.test());
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
                Notifications are blocked for this site. Allow them in your browser’s site settings
                (the icon left of the address bar), then reload Shrike.
              </>
            ) : tested === false ? (
              'Your browser didn’t show the test notification. Check your system’s notification settings.'
            ) : tested ? (
              <>
                <CircleCheck size={14} aria-hidden />
                Sent. If nothing appeared, check your system’s do-not-disturb setting.
              </>
            ) : undefined
          }
          noteTone={permission === 'denied' ? 'danger' : tested === false ? 'warning' : 'success'}
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
          control={
            <Segmented
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
          }
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
              variant="ghost"
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
          description="Shrike plays no sounds of its own. Your system may play its usual notification sound."
          disabled
        />
      </SettingsSection>
      <p className={styles.muted}>
        Notifications are shown by your browser while Shrike is open in a tab.
      </p>
    </>
  );
}

const PERMISSION_TEXT: Record<Permission, string> = {
  default: 'Shrike needs your browser’s permission before it can show desktop notifications.',
  granted: 'Allowed. Shrike can show desktop notifications.',
  denied: 'Blocked by your browser.',
  unsupported: 'This browser doesn’t support desktop notifications.',
};
