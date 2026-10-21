import type { PhonePrivacyStatus } from '@/core/stores';

/**
 * The status line under a setting that can follow the phone: says whether
 * the value shown is the phone's (and so synced both ways) or Snowdrop's own.
 */
export function phoneSettingNote(
  status: PhonePrivacyStatus,
  followsPhone: boolean,
  signalCli: boolean,
): string | undefined {
  if (status === 'pending') return 'Checking the setting on your phone…';
  if (status === 'ready') {
    return followsPhone
      ? 'Synced with your phone: changing it here changes it there too.'
      : 'Your phone hasn’t shared this setting yet, so this is Snowdrop’s own for now.';
  }
  return signalCli
    ? 'This signal-cli can’t read the setting from your phone, so this is Snowdrop’s own and doesn’t follow it. Update signal-cli to follow your phone.'
    : undefined;
}
