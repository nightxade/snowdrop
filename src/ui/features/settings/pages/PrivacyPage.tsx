import { useSyncExternalStore } from 'react';
import { useShrike } from '@/ui/hooks';
import { Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import styles from './pages.module.css';

function usePluginEnabled(id: string): [boolean, (on: boolean) => void] {
  const { plugins } = useShrike();
  const enabled = useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.get(id)?.enabled ?? false,
  );
  return [enabled, (on) => void plugins.setEnabled(id, on)];
}

export function PrivacyPage() {
  const [behaviour, setBehaviour] = useSettingsSection('behaviour');
  const [silent, setSilent] = usePluginEnabled('silent-typing');
  const [clearUrls, setClearUrls] = usePluginEnabled('clear-urls');
  return (
    <>
      <SettingsSection id="signals" title="What others see">
        <SettingRow
          id="privacy.receipts"
          label="Send read receipts"
          description="Lets people see when you’ve read their messages."
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
          label="Never send typing indicators"
          description="Turns on the Silent Typing plugin: nobody sees “typing…” from you, in any conversation."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={silent}
              onCheckedChange={setSilent}
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
            <li>Shrike has no telemetry and loads no fonts or scripts from the internet.</li>
          </ul>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
