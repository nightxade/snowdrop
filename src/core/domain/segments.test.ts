import { describe, expect, it } from 'vitest';
import {
  bodyToPlainText,
  cleanRanges,
  rangesToSegments,
  toAtoms,
  type Atom,
  type CleanRange,
  type Segment,
} from './segments';
import { MAX_BODY_RANGES, type BodyRange, type TextStyle } from './types';

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

describe('range limits and complexity', () => {
  /** The pre-sweep (quadratic) algorithm, kept verbatim as the reference. */
  function oldClean(body: string, ranges: readonly BodyRange[]): CleanRange[] {
    const snapOld = (index: number): number =>
      index > 0 &&
      index < body.length &&
      (body.charCodeAt(index - 1) & 0xfc00) === 0xd800 &&
      (body.charCodeAt(index) & 0xfc00) === 0xdc00
        ? index + 1
        : index;
    const out: CleanRange[] = [];
    const mentions: CleanRange[] = [];
    for (const r of ranges) {
      if (!Number.isFinite(r.start) || !Number.isFinite(r.length)) continue;
      const start = snapOld(Math.max(0, Math.min(body.length, Math.trunc(r.start))));
      const end = snapOld(Math.max(0, Math.min(body.length, Math.trunc(r.start + r.length))));
      if (end <= start) continue;
      if (r.mentionId !== undefined) {
        if (mentions.some((m) => start < m.end && end > m.start)) continue;
        const m = { start, end, mentionId: r.mentionId };
        mentions.push(m);
        out.push(m);
      } else if (r.style !== undefined) {
        out.push({ start, end, style: r.style });
      }
    }
    return out;
  }
  function oldAtoms(body: string, ranges: CleanRange[]): Atom[] {
    const mentions = ranges.filter((r) => r.mentionId !== undefined);
    const insideMention = (i: number): boolean => mentions.some((m) => i > m.start && i < m.end);
    const cuts = new Set<number>([0, body.length]);
    for (const r of ranges) {
      if (!insideMention(r.start)) cuts.add(r.start);
      if (!insideMention(r.end)) cuts.add(r.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const atoms: Atom[] = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const start = points[k] as number;
      const end = points[k + 1] as number;
      const styles = new Set<TextStyle>();
      let mentionId: string | undefined;
      for (const r of ranges) {
        if (r.start <= start && r.end >= end) {
          if (r.style) styles.add(r.style);
          if (r.mentionId !== undefined && r.start === start) mentionId = r.mentionId;
        }
      }
      atoms.push(
        mentionId === undefined ? { start, end, styles } : { start, end, styles, mentionId },
      );
    }
    return atoms;
  }

  // Flatten a segment tree into per-character style lists, independent of nesting shape.
  function perChar(segments: readonly Segment[], inherited: string[] = []): string[] {
    return segments.flatMap((s) => {
      if (s.type === 'text')
        return Array.from({ length: s.text.length }, () => [...inherited].sort().join(','));
      if (s.type === 'mention')
        return Array.from({ length: s.text.length }, () => `@${s.mentionId}`);
      return perChar(s.children, [...inherited, s.style]);
    });
  }

  it('matches a per-character oracle on random normal inputs', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const styles = ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'] as const;
    for (let round = 0; round < 200; round++) {
      const body = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 5 + rnd(21));
      const ranges: BodyRange[] = [];
      for (let i = 0, n = rnd(8); i < n; i++) {
        ranges.push({
          start: rnd(body.length),
          length: 1 + rnd(8),
          style: styles[rnd(styles.length)] as (typeof styles)[number],
        });
      }
      const expected = Array.from({ length: body.length }, (_, i) =>
        ranges
          .filter((r) => r.start <= i && r.start + r.length > i)
          .map((r) => r.style as string)
          .filter((v, idx, arr) => arr.indexOf(v) === idx)
          .sort()
          .join(','),
      );
      expect(perChar(rangesToSegments(body, ranges))).toEqual(expected);
    }
  });

  it('produces atoms identical to the old algorithm, mentions and surrogates included', () => {
    let seed = 99;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const styles = ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'] as const;
    for (let round = 0; round < 500; round++) {
      const body = Array.from(
        { length: 4 + rnd(30) },
        () => ['a', 'b', '\u{1F600}', '\uFFFC'][rnd(4)],
      ).join('');
      const ranges: BodyRange[] = Array.from({ length: rnd(12) }, () =>
        rnd(3) === 0
          ? { start: rnd(body.length + 3) - 1, length: rnd(4) - 1, mentionId: `m${rnd(5)}` }
          : {
              start: rnd(body.length + 3) - 1,
              length: rnd(10) - 1,
              style: styles[rnd(styles.length)] as (typeof styles)[number],
            },
      );
      const oldClean_ = oldClean(body, ranges);
      expect(cleanRanges(body, ranges, MAX_BODY_RANGES)).toEqual(oldClean_);
      const norm = (atoms: Atom[]): unknown[] =>
        atoms.map((a) => ({ ...a, styles: [...a.styles].sort() }));
      expect(norm(toAtoms(body, oldClean_))).toEqual(norm(oldAtoms(body, oldClean_)));
    }
  });

  it('keeps mentions atomic and first-one-wins when ranges overlap them', () => {
    const body = 'hi ￼ and ￼!';
    const segments = rangesToSegments(body, [
      { start: 3, length: 1, mentionId: 'a' },
      { start: 3, length: 1, mentionId: 'dup' },
      { start: 2, length: 4, style: 'bold' },
      { start: 9, length: 1, mentionId: 'b' },
    ]);
    const mentions: string[] = [];
    const walk = (list: readonly Segment[]): void => {
      for (const s of list) {
        if (s.type === 'mention') mentions.push(s.mentionId);
        else if (s.type === 'style') walk(s.children);
      }
    };
    walk(segments);
    expect(mentions).toEqual(['a', 'b']);
  });

  it('drops ranges beyond MAX_BODY_RANGES', () => {
    const body = 'x'.repeat(2000);
    const ranges: BodyRange[] = Array.from({ length: MAX_BODY_RANGES + 50 }, (_, i) => ({
      start: i,
      length: 1,
      style: 'bold',
    }));
    const styled = (segs: readonly Segment[]): number =>
      segs.reduce(
        (n, s) =>
          n +
          (s.type === 'style'
            ? s.children.reduce((m, c) => m + (c.type === 'text' ? c.text.length : 0), 0)
            : 0),
        0,
      );
    expect(styled(rangesToSegments(body, ranges))).toBe(MAX_BODY_RANGES);
  });

  it('renders a 20k-range message fast, capped and even uncapped', () => {
    const body = 'lorem ipsum '.repeat(2000);
    const styles = ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'] as const;
    const ranges: BodyRange[] = Array.from({ length: 20_000 }, (_, i) => ({
      start: (i * 7) % body.length,
      length: 1 + (i % 40),
      style: styles[i % styles.length] as (typeof styles)[number],
    }));
    let t = performance.now();
    rangesToSegments(body, ranges);
    expect(performance.now() - t).toBeLessThan(500);
    // The algorithm itself is O(R log R): without the cap it still finishes
    // well inside the old quadratic version's 3 s (generous to avoid flakes).
    t = performance.now();
    rangesToSegments(body, ranges, Infinity);
    expect(performance.now() - t).toBeLessThan(2500);
  });
});
