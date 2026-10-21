import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import { phoneSettingNote } from '../phoneSettingNote';
import { EncryptionSection } from './EncryptionSection';
import styles from './pages.module.css';

function usePluginEnabled(id: string): [boolean, (on: boolean) => void] {
  const { plugins } = useSnowdrop();
  const enabled = useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.get(id)?.enabled ?? false,
  );
  return [enabled, (on) => void plugins.setEnabled(id, on)];
}

type PhoneSetting = 'readReceipts' | 'typingIndicators' | 'linkPreviews';

export function PrivacyPage() {
  const app = useSnowdrop();
  const [, setBehaviour] = useSettingsSection('behaviour');
  const [clearUrls, setClearUrls] = usePluginEnabled('clear-urls');
  const privacy = useEffectivePrivacy();
  const phone = useStore(app.stores.session, sessionSelectors.phonePrivacy);
  const where = app.storageAdmin ? 'this computer' : 'this browser';
  const signalCli = app.backend.kind === 'signal-cli';
  const pending = phone.status === 'pending';
  const noteFor = (key: PhoneSetting) =>
    phoneSettingNote(phone.status, privacy.fromPhone[key], signalCli);
  /** Follows the phone when it has told us, and then writes back to it. */
  const change = (
    key: PhoneSetting,
    local: 'sendReadReceipts' | 'sendTypingIndicators',
    value: boolean,
  ) => {
    if (privacy.fromPhone[key]) void app.sync.updatePhonePrivacy({ [key]: value });
    else setBehaviour({ [local]: value });
  };
  const receiptsHiddenByPhone = privacy.fromPhone.readReceipts && !privacy.sendReadReceipts;
  const receiptsNote = noteFor('readReceipts');
  const typingNote = noteFor('typingIndicators');
  return (
    <>
      {app.storageAdmin && <EncryptionSection admin={app.storageAdmin} />}
      <SettingsSection id="signals" title="What others see">
        <SettingRow
          id="privacy.receipts"
          label="Send read receipts"
          description="When on, people see when you’ve read their messages. Like Signal’s own apps, turning it off also hides other people’s read marks on your messages."
          {...(receiptsNote ? { note: receiptsNote } : {})}
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={privacy.sendReadReceipts}
              disabled={pending}
              onCheckedChange={(v) => {
                change('readReceipts', 'sendReadReceipts', v);
              }}
            />
          )}
        />
        <SettingRow
          id="privacy.showReceipts"
          label="Show read receipts on your messages"
          description="Shows the small delivered/read mark after your own messages, and who’s read a group message in its Message details. Off hides the mark (a failed send still shows); this is purely a display choice and doesn’t change what you send or receive."
          {...(receiptsHiddenByPhone
            ? { note: 'Hidden while read receipts are off, as in Signal’s own apps.' }
            : {})}
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={privacy.showReadReceipts}
              disabled={receiptsHiddenByPhone}
              onCheckedChange={(v) => {
                setBehaviour({ showReadReceipts: v });
              }}
            />
          )}
        />
        <SettingRow
          id="privacy.typing"
          label="Send typing indicators"
          description="When on, people see “typing…” while you write to them. Off applies to every conversation."
          {...(typingNote ? { note: typingNote } : {})}
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={privacy.sendTypingIndicators}
              disabled={pending}
              onCheckedChange={(v) => {
                change('typingIndicators', 'sendTypingIndicators', v);
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
            <li>Private notes about people, pins, mutes and drafts never leave {where}.</li>
            <li>
              {app.storageAdmin
                ? 'Message history is kept encrypted on this computer, and signal-cli’s own data sits in an encrypted vault.'
                : 'Message history is stored in this browser (signal-cli keeps none).'}{' '}
              Export or clear it under Data &amp; storage.
            </li>
            <li>
              Snowdrop has no telemetry. Its fonts and code ship with it, and custom themes and
              Custom CSS can’t load anything from the internet: such references are removed, and the
              installed app blocks third-party requests outright.
            </li>
            <li>
              Snowdrop talks to signal-cli, and signal-cli talks to Signal. Two things reach
              further: link previews contact the linked site from this device (or your HTTPS_PROXY),
              which shows it your IP address, and you can turn them off under Behaviour. On desktop,
              downloading signal-cli the first time contacts github.com once.
            </li>
          </ul>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
