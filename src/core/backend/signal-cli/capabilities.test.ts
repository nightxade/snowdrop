import { describe, expect, it } from 'vitest';
import {
  MIN_ATTACHMENT_BACKFILL_PATCH_LEVEL,
  MIN_CATCHING_UP_SIGNAL_PATCH_LEVEL,
  MIN_CUSTOM_EMOJI_PATCH_LEVEL,
  MIN_DELETE_SYNC_PATCH_LEVEL,
  MIN_HISTORY_STICKER_PACK_PATCH_LEVEL,
  MIN_ORDERED_CATCHING_UP_PATCH_LEVEL,
  MIN_PHONE_PRIVACY_PATCH_LEVEL,
  MIN_READ_SYNC_PATCH_LEVEL,
  MIN_STICKER_PACK_INSTALL_PATCH_LEVEL,
  featuresForVersion,
  supportsAttachmentBackfill,
  supportsCatchingUpSignal,
  supportsCustomEmojiDelivery,
  supportsDeleteSync,
  supportsHistoryStickerPack,
  supportsOrderedCatchingUp,
  supportsPhonePrivacy,
  supportsReadSync,
  supportsStickerPackInstall,
} from './capabilities';

describe('supportsCustomEmojiDelivery', () => {
  it('is false for undefined or empty versions', () => {
    expect(supportsCustomEmojiDelivery(undefined)).toBe(false);
    expect(supportsCustomEmojiDelivery('')).toBe(false);
  });

  it('is false for upstream signal-cli (no snowdrop suffix at all)', () => {
    expect(supportsCustomEmojiDelivery('0.14.8')).toBe(false);
  });

  it('is false for a patched build below the required patch level', () => {
    expect(supportsCustomEmojiDelivery('0.14.8-snowdrop-history.9')).toBe(false);
    expect(supportsCustomEmojiDelivery('0.14.8-snowdrop-history.1')).toBe(false);
  });

  it('is true at exactly the required patch level and above', () => {
    expect(
      supportsCustomEmojiDelivery(`0.14.8-snowdrop-history.${MIN_CUSTOM_EMOJI_PATCH_LEVEL}`),
    ).toBe(true);
    expect(supportsCustomEmojiDelivery('0.14.8-snowdrop-history.11')).toBe(true);
    expect(supportsCustomEmojiDelivery('0.14.8-snowdrop-history.100')).toBe(true);
  });

  it('is false for a malformed or unrelated suffix', () => {
    expect(supportsCustomEmojiDelivery('0.14.8-snowdrop-history.')).toBe(false);
    expect(supportsCustomEmojiDelivery('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsAttachmentBackfill', () => {
  it('is false for undefined or empty versions', () => {
    expect(supportsAttachmentBackfill(undefined)).toBe(false);
    expect(supportsAttachmentBackfill('')).toBe(false);
  });

  it('is false for upstream signal-cli (no snowdrop suffix at all)', () => {
    expect(supportsAttachmentBackfill('0.14.8')).toBe(false);
  });

  it('is false for a patched build below the required patch level', () => {
    expect(supportsAttachmentBackfill('0.14.8-snowdrop-history.13')).toBe(false);
    expect(supportsAttachmentBackfill('0.14.8-snowdrop-history.1')).toBe(false);
  });

  it('is true at exactly the required patch level and above', () => {
    expect(
      supportsAttachmentBackfill(`0.14.8-snowdrop-history.${MIN_ATTACHMENT_BACKFILL_PATCH_LEVEL}`),
    ).toBe(true);
    expect(supportsAttachmentBackfill('0.14.8-snowdrop-history.100')).toBe(true);
  });

  it('is false for a malformed or unrelated suffix', () => {
    expect(supportsAttachmentBackfill('0.14.8-snowdrop-history.')).toBe(false);
    expect(supportsAttachmentBackfill('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsHistoryStickerPack', () => {
  it('is false for undefined or empty versions', () => {
    expect(supportsHistoryStickerPack(undefined)).toBe(false);
    expect(supportsHistoryStickerPack('')).toBe(false);
  });

  it('is false for upstream signal-cli (no snowdrop suffix at all)', () => {
    expect(supportsHistoryStickerPack('0.14.8')).toBe(false);
  });

  it('is false for a patched build below the required patch level', () => {
    expect(supportsHistoryStickerPack('0.14.8-snowdrop-history.14')).toBe(false);
    expect(supportsHistoryStickerPack('0.14.8-snowdrop-history.1')).toBe(false);
  });

  it('is true at exactly the required patch level and above', () => {
    expect(
      supportsHistoryStickerPack(`0.14.8-snowdrop-history.${MIN_HISTORY_STICKER_PACK_PATCH_LEVEL}`),
    ).toBe(true);
    expect(supportsHistoryStickerPack('0.14.8-snowdrop-history.100')).toBe(true);
  });

  it('is false for a malformed or unrelated suffix', () => {
    expect(supportsHistoryStickerPack('0.14.8-snowdrop-history.')).toBe(false);
    expect(supportsHistoryStickerPack('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsStickerPackInstall', () => {
  it('is false without a version, for upstream, and below patch level 17', () => {
    expect(supportsStickerPackInstall(undefined)).toBe(false);
    expect(supportsStickerPackInstall('0.14.8')).toBe(false);
    expect(supportsStickerPackInstall('0.14.8-snowdrop-history.16')).toBe(false);
  });

  it('is true from the 0017 patch level on', () => {
    expect(MIN_STICKER_PACK_INSTALL_PATCH_LEVEL).toBe(17);
    expect(supportsStickerPackInstall('0.14.8-snowdrop-history.17')).toBe(true);
    expect(supportsStickerPackInstall('0.14.8-snowdrop-history.40')).toBe(true);
    expect(supportsStickerPackInstall('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsPhonePrivacy', () => {
  it('is false without a version, for upstream, and below patch level 18', () => {
    expect(supportsPhonePrivacy(undefined)).toBe(false);
    expect(supportsPhonePrivacy('')).toBe(false);
    expect(supportsPhonePrivacy('0.14.8')).toBe(false);
    expect(supportsPhonePrivacy('0.14.8-snowdrop-history.17')).toBe(false);
  });

  it('is true from the 0018 patch level on', () => {
    expect(MIN_PHONE_PRIVACY_PATCH_LEVEL).toBe(18);
    expect(supportsPhonePrivacy('0.14.8-snowdrop-history.18')).toBe(true);
    expect(supportsPhonePrivacy('0.14.8-snowdrop-history.40')).toBe(true);
    expect(supportsPhonePrivacy('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsReadSync', () => {
  it('is false without a version, for upstream, and below patch level 19', () => {
    expect(supportsReadSync(undefined)).toBe(false);
    expect(supportsReadSync('0.14.8')).toBe(false);
    expect(supportsReadSync('0.14.8-snowdrop-history.18')).toBe(false);
  });

  it('is true from the 0019 patch level on', () => {
    expect(MIN_READ_SYNC_PATCH_LEVEL).toBe(19);
    expect(supportsReadSync('0.14.8-snowdrop-history.19')).toBe(true);
    expect(supportsReadSync('0.14.8-snowdrop-history.40')).toBe(true);
    expect(supportsReadSync('0.14.8-some-other-fork.20')).toBe(false);
  });
});

describe('supportsCatchingUpSignal', () => {
  it('is false without a version, for upstream, and below patch level 21', () => {
    expect(supportsCatchingUpSignal(undefined)).toBe(false);
    expect(supportsCatchingUpSignal('0.14.8')).toBe(false);
    expect(supportsCatchingUpSignal('0.14.8-snowdrop-history.20')).toBe(false);
  });

  it('is true from build 21 on', () => {
    expect(MIN_CATCHING_UP_SIGNAL_PATCH_LEVEL).toBe(21);
    expect(supportsCatchingUpSignal('0.14.8-snowdrop-history.21')).toBe(true);
    expect(supportsCatchingUpSignal('0.14.8-snowdrop-history.40')).toBe(true);
    expect(supportsCatchingUpSignal('0.14.8-some-other-fork.30')).toBe(false);
  });
});

describe('supportsOrderedCatchingUp', () => {
  it('is false without a version, for upstream, and below patch level 23', () => {
    expect(supportsOrderedCatchingUp(undefined)).toBe(false);
    expect(supportsOrderedCatchingUp('0.14.8')).toBe(false);
    expect(supportsOrderedCatchingUp('0.14.8-snowdrop-history.21')).toBe(false);
    expect(supportsOrderedCatchingUp('0.14.8-snowdrop-history.22')).toBe(false);
  });

  it('is true from build 23 on', () => {
    expect(MIN_ORDERED_CATCHING_UP_PATCH_LEVEL).toBe(23);
    expect(supportsOrderedCatchingUp('0.14.8-snowdrop-history.23')).toBe(true);
    expect(supportsOrderedCatchingUp('0.14.8-snowdrop-history.40')).toBe(true);
    expect(supportsOrderedCatchingUp('0.14.8-some-other-fork.30')).toBe(false);
  });
});

describe('supportsDeleteSync', () => {
  it('is false for undefined, empty, upstream and unrelated versions', () => {
    expect(supportsDeleteSync(undefined)).toBe(false);
    expect(supportsDeleteSync('')).toBe(false);
    expect(supportsDeleteSync('0.14.8')).toBe(false);
    expect(supportsDeleteSync('0.14.8-snowdrop-history.')).toBe(false);
    expect(supportsDeleteSync('0.14.8-some-other-fork.30')).toBe(false);
  });

  it('is false below patch level 27 and true from it', () => {
    expect(MIN_DELETE_SYNC_PATCH_LEVEL).toBe(27);
    expect(supportsDeleteSync('0.14.8-snowdrop-history.26')).toBe(false);
    expect(supportsDeleteSync('0.14.8-snowdrop-history.27')).toBe(true);
    expect(supportsDeleteSync('0.14.8-snowdrop-history.100')).toBe(true);
  });

  it('is reported as the deleteSync feature', () => {
    expect(featuresForVersion('0.14.8-snowdrop-history.27').has('deleteSync')).toBe(true);
    expect(featuresForVersion('0.14.8-snowdrop-history.26').has('deleteSync')).toBe(false);
    expect(featuresForVersion(undefined).has('deleteSync')).toBe(false);
  });
});
