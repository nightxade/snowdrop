import { describe, expect, it } from 'vitest';
import { displayedText, foldedTerms, foldText, foldWithMap } from './searchText';
import { makeMessage } from './testing';

describe('foldText', () => {
  it('ignores case, diacritics and the composed or decomposed form', () => {
    expect(foldText('Café')).toBe('cafe');
    expect(foldText('RÉSUMÉ')).toBe('resume');
    expect(foldText('résumé')).toBe(foldText('résumé'));
    expect(foldText('Ångström')).toBe('angstrom');
  });

  it('leaves other scripts and plain text alone', () => {
    expect(foldText('hello World')).toBe('hello world');
    expect(foldText('東京タワー')).toBe('東京タワー');
    // A vowel sign is part of a Devanagari letter, not a diacritic to drop.
    expect(foldText('का')).toBe('का');
  });
});

describe('foldWithMap', () => {
  it('says which characters of the original each folded one came from', () => {
    const { folded, from, to } = foldWithMap('Café!');
    expect(folded).toBe('cafe!');
    // The decomposed é is two code units, the 'e' and its accent: the span covers both.
    expect([from[3], to[3]]).toEqual([3, 5]);
    expect([from[4], to[4]]).toEqual([5, 6]);
  });
});

describe('foldedTerms', () => {
  it('folds and splits on whitespace', () => {
    expect(foldedTerms('  Café   LUNCH ')).toEqual(['cafe', 'lunch']);
    expect(foldedTerms('   ')).toEqual([]);
  });
});

describe('displayedText', () => {
  it('shows a mention as @name, and a poll as its question', () => {
    const m = makeMessage({
      body: 'hi ￼!',
      ranges: [{ start: 3, length: 1, mentionId: 'ana' }],
    });
    expect(displayedText(m, () => 'Ana')).toBe('hi @Ana!');
    expect(displayedText(m)).toBe('hi ￼!');
    const poll = { question: 'Pizza?', options: ['y', 'n'], allowMultiple: false, votes: [] };
    expect(displayedText(makeMessage({ body: '', poll }), () => '')).toBe('Pizza?');
  });
});
