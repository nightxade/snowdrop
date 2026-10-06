import { describe, expect, it, vi } from 'vitest';
import { splitGraphemes } from './graphemes';

describe('splitGraphemes', () => {
  it('treats a ZWJ emoji family as one grapheme cluster, not several code points', () => {
    const family = '👨‍👩‍👧‍👦'; // four people joined by ZWJ: one grapheme cluster
    expect(splitGraphemes(family)).toEqual([family]);
    expect(splitGraphemes(family)).not.toEqual(Array.from(family));
  });

  it('splits plain text into one entry per character', () => {
    expect(splitGraphemes('abc')).toEqual(['a', 'b', 'c']);
  });

  it('never throws when Intl.Segmenter is unavailable (falls back to a code-point split)', async () => {
    vi.resetModules();
    const intl = Intl as { Segmenter?: typeof Intl.Segmenter | undefined };
    const original = intl.Segmenter;
    delete intl.Segmenter;
    try {
      const { splitGraphemes: fallbackSplit } = await import('./graphemes');
      expect(fallbackSplit('abc')).toEqual(['a', 'b', 'c']);
    } finally {
      intl.Segmenter = original;
      vi.resetModules();
    }
  });
});
