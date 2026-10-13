import { describe, expect, it } from 'vitest';
import { MIN_CUSTOM_EMOJI_PATCH_LEVEL, supportsCustomEmojiDelivery } from './capabilities';

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
