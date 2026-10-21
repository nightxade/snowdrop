import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings';
import {
  UNKNOWN_PHONE_PRIVACY,
  effectivePrivacy,
  initialPhonePrivacy,
  type PhonePrivacyState,
} from './privacy';

const local = defaultSettings().behaviour;
const ready = (values: Partial<PhonePrivacyState['values']>): PhonePrivacyState => ({
  status: 'ready',
  values: { ...UNKNOWN_PHONE_PRIVACY, ...values },
});

describe('effectivePrivacy', () => {
  it('uses the local settings when the backend cannot report the phone’s', () => {
    const on = effectivePrivacy(local, initialPhonePrivacy());
    expect(on).toMatchObject({
      sendReadReceipts: true,
      sendTypingIndicators: true,
      linkPreviews: true,
      settled: true,
    });
    expect(on.fromPhone).toEqual({
      readReceipts: false,
      typingIndicators: false,
      linkPreviews: false,
    });
    const off = effectivePrivacy(
      { ...local, sendReadReceipts: false, sendTypingIndicators: false, linkPreviews: false },
      initialPhonePrivacy(),
    );
    expect(off).toMatchObject({
      sendReadReceipts: false,
      sendTypingIndicators: false,
      linkPreviews: false,
    });
  });

  it('turns everything that depends on the phone off while the first read is pending', () => {
    const pending = effectivePrivacy(local, { status: 'pending', values: UNKNOWN_PHONE_PRIVACY });
    expect(pending).toMatchObject({
      sendReadReceipts: false,
      sendTypingIndicators: false,
      linkPreviews: false,
      settled: false,
    });
  });

  it('lets known phone values win over the local ones, in both directions', () => {
    const phoneOff = effectivePrivacy(
      local,
      ready({ readReceipts: false, typingIndicators: false, linkPreviews: false }),
    );
    expect(phoneOff).toMatchObject({
      sendReadReceipts: false,
      sendTypingIndicators: false,
      linkPreviews: false,
    });
    expect(phoneOff.fromPhone).toEqual({
      readReceipts: true,
      typingIndicators: true,
      linkPreviews: true,
    });
    const phoneOn = effectivePrivacy(
      { ...local, sendReadReceipts: false, sendTypingIndicators: false, linkPreviews: false },
      ready({ readReceipts: true, typingIndicators: true, linkPreviews: true }),
    );
    expect(phoneOn).toMatchObject({
      sendReadReceipts: true,
      sendTypingIndicators: true,
      linkPreviews: true,
    });
  });

  it('falls back to the local value one setting at a time when the phone has not sent it', () => {
    const result = effectivePrivacy(
      { ...local, sendReadReceipts: false, sendTypingIndicators: true },
      ready({ typingIndicators: false }),
    );
    expect(result.sendReadReceipts).toBe(false);
    expect(result.sendTypingIndicators).toBe(false);
    expect(result.linkPreviews).toBe(true);
    expect(result.fromPhone).toEqual({
      readReceipts: false,
      typingIndicators: true,
      linkPreviews: false,
    });
  });

  it('hides read marks while the phone has read receipts off, and otherwise follows the display setting', () => {
    expect(effectivePrivacy(local, ready({ readReceipts: false })).showReadReceipts).toBe(false);
    expect(effectivePrivacy(local, ready({ readReceipts: true })).showReadReceipts).toBe(true);
    expect(
      effectivePrivacy({ ...local, showReadReceipts: false }, ready({ readReceipts: true }))
        .showReadReceipts,
    ).toBe(false);
    // Unknown or unsupported: the local display setting alone (today's behaviour).
    expect(effectivePrivacy(local, ready({})).showReadReceipts).toBe(true);
    expect(
      effectivePrivacy({ ...local, sendReadReceipts: false }, initialPhonePrivacy())
        .showReadReceipts,
    ).toBe(true);
  });
});
