import { describe, expect, it } from 'vitest';
import {
  MIN_ATTACHMENT_BACKFILL_PATCH_LEVEL,
  MIN_CUSTOM_EMOJI_PATCH_LEVEL,
  MIN_HISTORY_STICKER_PACK_PATCH_LEVEL,
  supportsAttachmentBackfill,
  supportsCustomEmojiDelivery,
  supportsHistoryStickerPack,
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
