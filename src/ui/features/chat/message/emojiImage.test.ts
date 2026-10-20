import { describe, expect, it } from 'vitest';
import { imagePayload, suggestEmojiName } from './emojiImage';

describe('imagePayload', () => {
  it('is the base64 body, whatever the type label', () => {
    expect(imagePayload('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(imagePayload('data:image/webp;base64,QUJD')).toBe('QUJD');
  });
});

describe('suggestEmojiName', () => {
  it('appends the first free numeric suffix', () => {
    expect(suggestEmojiName('wave', () => false)).toBe('wave_2');
    expect(suggestEmojiName('wave', (n) => n === 'wave_2' || n === 'wave_3')).toBe('wave_4');
  });

  it('stays within 32 characters by trimming the base name', () => {
    const long = 'a'.repeat(32);
    const suggestion = suggestEmojiName(long, () => false);
    expect(suggestion).toBe(`${'a'.repeat(30)}_2`);
    expect(suggestion).toHaveLength(32);
  });
});
