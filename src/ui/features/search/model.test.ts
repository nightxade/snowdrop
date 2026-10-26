import { describe, expect, it } from 'vitest';
import { makeMessage } from '@/core/domain/testing';
import { queryTerms, resultText, snippetParts } from './model';

const joined = (parts: { text: string; hit: boolean }[]) => parts.map((p) => p.text).join('');
const hits = (parts: { text: string; hit: boolean }[]) =>
  parts.filter((p) => p.hit).map((p) => p.text);

describe('queryTerms', () => {
  it('lowercases and splits on whitespace', () => {
    expect(queryTerms('  Hello   WORLD ')).toEqual(['hello', 'world']);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('snippetParts', () => {
  it('flags every occurrence of every term, case-insensitively', () => {
    const parts = snippetParts('Lunch at noon, lunch again', ['lunch', 'noon']);
    expect(joined(parts)).toBe('Lunch at noon, lunch again');
    expect(hits(parts)).toEqual(['Lunch', 'noon', 'lunch']);
  });

  it('centres a long message on the first match and marks the cut ends', () => {
    const text = `${'word '.repeat(60)}needle ${'tail '.repeat(60)}`;
    const parts = snippetParts(text, ['needle']);
    expect(parts[0]?.text).toBe('…');
    expect(parts.at(-1)?.text).toBe('…');
    expect(hits(parts)).toEqual(['needle']);
    expect(joined(parts).length).toBeLessThan(200);
  });

  it('collapses newlines to spaces', () => {
    expect(joined(snippetParts('one\n\ntwo', ['two']))).toBe('one two');
  });
});

describe('resultText', () => {
  it('shows a poll as its question', () => {
    const poll = { question: 'Pizza?', options: ['y', 'n'], allowMultiple: false, votes: [] };
    expect(resultText(makeMessage({ body: '', poll }), () => '')).toBe('Pizza?');
  });

  it('replaces a mention placeholder with @name', () => {
    const m = makeMessage({
      body: 'hi ￼!',
      ranges: [{ start: 3, length: 1, mentionId: 'ana' }],
    });
    expect(resultText(m, () => 'Ana')).toBe('hi @Ana!');
  });
});
