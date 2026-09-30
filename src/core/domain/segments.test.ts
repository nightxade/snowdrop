import { describe, expect, it } from 'vitest';
import { bodyToPlainText, rangesToSegments, type Segment } from './segments';

const text = (t: string): Segment => ({ type: 'text', text: t });

describe('rangesToSegments', () => {
  it('returns a single text node without ranges', () => {
    expect(rangesToSegments('hello', [])).toEqual([text('hello')]);
    expect(rangesToSegments('', [{ start: 0, length: 1, style: 'bold' }])).toEqual([]);
  });

  it('wraps a simple range', () => {
    expect(rangesToSegments('a bold b', [{ start: 2, length: 4, style: 'bold' }])).toEqual([
      text('a '),
      { type: 'style', style: 'bold', children: [text('bold')] },
      text(' b'),
    ]);
  });

  it('nests properly nested ranges', () => {
    expect(
      rangesToSegments('bold italic', [
        { start: 0, length: 11, style: 'bold' },
        { start: 5, length: 6, style: 'italic' },
      ]),
    ).toEqual([
      {
        type: 'style',
        style: 'bold',
        children: [text('bold '), { type: 'style', style: 'italic', children: [text('italic')] }],
      },
    ]);
  });

  it('splits overlapping ranges into a valid tree', () => {
    // bold: "abcde" (0..5), italic: "defgh" (3..8)
    const segments = rangesToSegments('abcdefgh', [
      { start: 0, length: 5, style: 'bold' },
      { start: 3, length: 5, style: 'italic' },
    ]);
    expect(segments).toEqual([
      {
        type: 'style',
        style: 'bold',
        children: [text('abc'), { type: 'style', style: 'italic', children: [text('de')] }],
      },
      { type: 'style', style: 'italic', children: [text('fgh')] },
    ]);
  });

  it('replaces mention placeholders with mention segments', () => {
    expect(rangesToSegments('hi ￼!', [{ start: 3, length: 1, mentionId: 'aci-1' }])).toEqual([
      text('hi '),
      { type: 'mention', mentionId: 'aci-1', text: '￼' },
      text('!'),
    ]);
  });

  it('styles mentions covered by a style range, keeping them atomic', () => {
    const segments = rangesToSegments('x￼y', [
      { start: 1, length: 1, mentionId: 'm' },
      { start: 0, length: 3, style: 'bold' },
    ]);
    expect(segments).toEqual([
      {
        type: 'style',
        style: 'bold',
        children: [text('x'), { type: 'mention', mentionId: 'm', text: '￼' }, text('y')],
      },
    ]);
  });

  it('never splits a mention even if a style boundary falls inside it', () => {
    const segments = rangesToSegments('@Longname rest', [
      { start: 0, length: 9, mentionId: 'm' },
      { start: 4, length: 6, style: 'bold' },
    ]);
    expect(segments[0]).toEqual({ type: 'mention', mentionId: 'm', text: '@Longname' });
  });

  it('drops out-of-bounds, empty and overlapping mention ranges', () => {
    expect(
      rangesToSegments('abc', [
        { start: 5, length: 2, style: 'bold' },
        { start: 1, length: 0, style: 'italic' },
        { start: -3, length: 4, style: 'spoiler' },
        { start: 0, length: 2, mentionId: 'a' },
        { start: 1, length: 1, mentionId: 'b' },
      ]),
    ).toEqual([
      // The clamped spoiler (0..1) ends inside the atomic mention, so it doesn't apply.
      { type: 'mention', mentionId: 'a', text: 'ab' },
      text('c'),
    ]);
  });

  it('does not split surrogate pairs', () => {
    const segments = rangesToSegments('😀x', [{ start: 1, length: 2, style: 'bold' }]);
    expect(segments).toEqual([text('😀'), { type: 'style', style: 'bold', children: [text('x')] }]);
  });

  it('preserves every character exactly once', () => {
    const body = 'The quick 🦊 jumps over ￼ lazy dog';
    const flat = (s: readonly Segment[]): string =>
      s.map((x) => (x.type === 'style' ? flat(x.children) : x.text)).join('');
    const segments = rangesToSegments(body, [
      { start: 0, length: 12, style: 'bold' },
      { start: 4, length: 15, style: 'italic' },
      { start: 10, length: 20, style: 'spoiler' },
      { start: 24, length: 1, mentionId: 'm' },
    ]);
    expect(flat(segments)).toBe(body);
  });
});

describe('bodyToPlainText', () => {
  it('resolves mentions and strips stray placeholders', () => {
    expect(
      bodyToPlainText('hi ￼ and ￼', [{ start: 3, length: 1, mentionId: 'a' }], (id) =>
        id === 'a' ? 'Ines' : '?',
      ),
    ).toBe('hi @Ines and ');
  });
});
