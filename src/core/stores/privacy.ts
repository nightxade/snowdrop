import type { PhonePrivacySettings } from '@/core/backend';
import type { BehaviourSettings } from './settings';

/**
 * Where the privacy settings Snowdrop sends with come from.
 *
 * Signal keeps read receipts, typing indicators and link previews as account
 * settings the primary device owns and linked devices follow (Signal Desktop
 * stores them from the phone's configuration sync and storage-service account
 * record, and pushes its own changes back). patches/signal-cli's "0022"
 * exposes the same stored values:
 *
 * - `unsupported`: this backend can't say (the demo, upstream or an older
 *   patched signal-cli). Snowdrop's own local settings apply.
 * - `pending`: it can, but the first read after connecting hasn't finished.
 *   Nothing that depends on these settings is sent yet.
 * - `ready`: `values` hold what the phone said. A value the phone hasn't
 *   sent yet is `null`, and that one setting falls back to the local one.
 */
export type PhonePrivacyStatus = 'unsupported' | 'pending' | 'ready';

export interface PhonePrivacyState {
  status: PhonePrivacyStatus;
  values: PhonePrivacySettings;
}

export const UNKNOWN_PHONE_PRIVACY: PhonePrivacySettings = {
  readReceipts: null,
  typingIndicators: null,
  linkPreviews: null,
  unidentifiedDeliveryIndicators: null,
};

export function initialPhonePrivacy(): PhonePrivacyState {
  return { status: 'unsupported', values: UNKNOWN_PHONE_PRIVACY };
}

export interface EffectivePrivacy {
  /** Whether Snowdrop may send read receipts right now. */
  sendReadReceipts: boolean;
  sendTypingIndicators: boolean;
  /** Whether Snowdrop may fetch link previews right now. */
  linkPreviews: boolean;
  /**
   * Whether to show delivered/read marks. Signal shows you other people's
   * receipts only while your own read receipts are on, so a phone that has
   * them off hides the marks whatever the display preference says.
   */
  showReadReceipts: boolean;
  /** Which of the above follow the phone rather than a local setting. */
  fromPhone: { readReceipts: boolean; typingIndicators: boolean; linkPreviews: boolean };
  /** False while waiting for the first read from the phone: hold anything that depends on it. */
  settled: boolean;
}

/** The one place local settings and the phone's values are combined. */
export function effectivePrivacy(
  behaviour: Pick<
    BehaviourSettings,
    'sendReadReceipts' | 'sendTypingIndicators' | 'showReadReceipts' | 'linkPreviews'
  >,
  phone: PhonePrivacyState,
): EffectivePrivacy {
  if (phone.status === 'pending') {
    return {
      sendReadReceipts: false,
      sendTypingIndicators: false,
      linkPreviews: false,
      showReadReceipts: behaviour.showReadReceipts,
      fromPhone: { readReceipts: false, typingIndicators: false, linkPreviews: false },
      settled: false,
    };
  }
  const known = phone.status === 'ready' ? phone.values : UNKNOWN_PHONE_PRIVACY;
  const pick = (phoneValue: boolean | null, local: boolean): boolean => phoneValue ?? local;
  const sendReadReceipts = pick(known.readReceipts, behaviour.sendReadReceipts);
  return {
    sendReadReceipts,
    sendTypingIndicators: pick(known.typingIndicators, behaviour.sendTypingIndicators),
    linkPreviews: pick(known.linkPreviews, behaviour.linkPreviews),
    showReadReceipts: behaviour.showReadReceipts && known.readReceipts !== false,
    fromPhone: {
      readReceipts: known.readReceipts !== null,
      typingIndicators: known.typingIndicators !== null,
      linkPreviews: known.linkPreviews !== null,
    },
    settled: true,
  };
}
