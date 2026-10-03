import { useSyncExternalStore } from 'react';
import { useSnowdrop } from '@/ui/hooks';
import { Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import styles from './pages.module.css';

function usePluginEnabled(id: string): [boolean, (on: boolean) => void] {
  const { plugins } = useSnowdrop();
  const enabled = useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.get(id)?.enabled ?? false,
  );
  return [enabled, (on) => void plugins.setEnabled(id, on)];
}

export function PrivacyPage() {
  const [behaviour, setBehaviour] = useSettingsSection('behaviour');
  const [clearUrls, setClearUrls] = usePluginEnabled('clear-urls');
  return (
    <>
      <SettingsSection id="signals" title="What others see">
        <SettingRow
          id="privacy.receipts"
          label="Send read receipts"
          description="When on, people see when you’ve read their messages. Turning it off only stops Snowdrop sending them: you still see other people’s receipts here (Signal’s own apps hide both)."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={behaviour.sendReadReceipts}
              onCheckedChange={(v) => {
                setBehaviour({ sendReadReceipts: v });
              }}
            />
          )}
        />
        <SettingRow
          id="privacy.typing"
          label="Send typing indicators"
          description="When on, people see “typing…” while you write to them. Off applies to every conversation."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={behaviour.sendTypingIndicators}
              onCheckedChange={(v) => {
                setBehaviour({ sendTypingIndicators: v });
              }}
            />
          )}
        />
      </SettingsSection>
      <SettingsSection id="links" title="Links">
        <SettingRow
          id="privacy.clearUrls"
          label="Strip tracking parameters from links"
          description="Turns on the Clear URLs plugin: utm_*, fbclid and similar are removed from links before you send them."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={clearUrls}
              onCheckedChange={setClearUrls}
            />
          )}
        />
      </SettingsSection>
      <SettingsSection id="local" title="On this device">
        <SettingRow id="privacy.local" label="What stays on this device" stacked>
          <ul className={styles.facts}>
            <li>
              Spaces, folders and categories are only on this device. Nobody sees how you organise
              them.
            </li>
            <li>Private notes about people, pins, mutes and drafts never leave this browser.</li>
            <li>
              Message history is stored in this browser (signal-cli keeps none). Export or clear it
              under Data &amp; storage.
            </li>
            <li>
              Snowdrop has no telemetry. Its fonts and code ship with it, and custom themes and
              Custom CSS can’t load anything from the internet: such references are removed, and the
              installed app blocks third-party requests outright.
            </li>
            <li>
              Snowdrop talks only to your signal-cli daemon, and that goes through this app’s own
              address.
            </li>
          </ul>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
