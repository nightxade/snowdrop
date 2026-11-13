import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { phoneSettingNote } from './phoneSettingNote';
import { useSettingsSection } from './useSettingsSection';

type PhoneSetting = 'readReceipts' | 'typingIndicators' | 'linkPreviews';
type LocalKey = 'sendReadReceipts' | 'sendTypingIndicators' | 'linkPreviews';

/**
 * A privacy setting that follows the phone when the phone owns it: `change`
 * writes to the phone then, and to Snowdrop's own behaviour setting
 * otherwise. `pending` is true while the phone's value is still being
 * fetched (the switch is disabled); `note` is the status line under it.
 */
export function usePhoneSetting(key: PhoneSetting, local: LocalKey) {
  const app = useSnowdrop();
  const [, setBehaviour] = useSettingsSection('behaviour');
  const privacy = useEffectivePrivacy();
  const phone = useStore(app.stores.session, sessionSelectors.phonePrivacy);
  return {
    pending: phone.status === 'pending',
    note: phoneSettingNote(phone.status, privacy.fromPhone[key], app.backend.kind === 'signal-cli'),
    change: (value: boolean) => {
      if (privacy.fromPhone[key]) void app.sync.updatePhonePrivacy({ [key]: value });
      else setBehaviour({ [local]: value });
    },
  };
}
