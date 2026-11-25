import { describe, expect, it } from 'vitest';
import { makeMessage } from '@/core/domain/testing';
import { followMemory, queryTerms, resultText, snippetParts } from './model';

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

describe('snippetParts across diacritics and normal forms', () => {
  it('marks the original characters a folded term matched', () => {
    expect(
      hits(snippetParts('Meet at the Café, then the résumé', queryTerms('cafe resume'))),
    ).toEqual(['Café', 'résumé']);
    // A decomposed message (e + combining accent) is marked whole, accent included.
    const decomposed = 'caf\u0065\u0301 time';
    expect(hits(snippetParts(decomposed, queryTerms('café')))).toEqual(['caf\u0065\u0301']);
    expect(joined(snippetParts(decomposed, queryTerms('café')))).toBe(decomposed);
  });

  it('lines up with the displayed text when a long message is cut around the match', () => {
    const text = `${'écrit '.repeat(40)}Straße café ${'fin '.repeat(40)}`;
    const parts = snippetParts(text, queryTerms('CAFE'));
    expect(hits(parts)).toEqual(['café']);
  });

  it('marks a mention by the name the message shows, with or without the @', () => {
    const m = makeMessage({
      body: 'hey ￼ about lunch',
      ranges: [{ start: 4, length: 1, mentionId: 'jun' }],
    });
    const shown = resultText(m, () => 'Juniper Hale');
    expect(hits(snippetParts(shown, queryTerms('juniper')))).toEqual(['Juniper']);
    expect(hits(snippetParts(shown, queryTerms('@juniper')))).toEqual(['@Juniper']);
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

describe('followMemory', () => {
  const at = (sentAt: number, body: string) =>
    makeMessage({ authorId: 'a', sentAt, body, conversationId: 'c' as never });
  const name = () => 'x';
  const terms = queryTerms('fish');

  it('drops what left or stopped matching, updates edits, inserts arrivals by sent time, cuts to the limit', () => {
    const a = at(10, 'fish a');
    const b = at(20, 'fish b');
    const c = at(30, 'fish c');
    const edited = { ...a, body: 'fish a2', edits: 1 };
    const stopped = { ...b, body: 'carp b', edits: 1 };
    const arrival = at(25, 'new fish');
    const memory = new Map([
      [a.id, edited],
      [b.id, stopped],
      [arrival.id, arrival],
    ]);
    const next = followMemory([c, b, a], memory, [edited, stopped, arrival], {}, terms, name, 3);
    expect(next.map((m) => m.body)).toEqual(['fish c', 'new fish', 'fish a2']);
    expect(followMemory([c], memory, [], { [c.id]: true }, terms, name, 3)).toEqual([]);
    expect(
      followMemory(next, memory, [at(40, 'top fish')], {}, terms, name, 2).map((m) => m.sentAt),
    ).toEqual([40, 30]);
  });

  it('returns the same list when nothing changed', () => {
    const a = at(10, 'fish');
    const results = [a];
    expect(followMemory(results, new Map([[a.id, a]]), [a], {}, terms, name, 5)).toBe(results);
  });
});
