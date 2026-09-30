import { describe, expect, it } from 'vitest';
import { escapeMarkdown, parseMarkdownToRanges } from './markdown';
import type { BodyRange } from './types';

const p = parseMarkdownToRanges;
const r = (start: number, length: number, style: BodyRange['style']): BodyRange => ({
  start,
  length,
  ...(style ? { style } : {}),
});

describe('parseMarkdownToRanges', () => {
  it('passes plain text through untouched', () => {
    expect(p('hello world')).toEqual({ body: 'hello world', ranges: [] });
    expect(p('')).toEqual({ body: '', ranges: [] });
  });

  it.each([
    ['**bold**', 'bold'],
    ['*it*', 'italic'],
    ['_it_', 'italic'],
    ['~~gone~~', 'strikethrough'],
    ['||secret||', 'spoiler'],
    ['`code`', 'monospace'],
  ] as const)('parses %s as %s', (input, style) => {
    const { body, ranges } = p(input);
    expect(ranges).toEqual([r(0, body.length, style)]);
    expect(body).toBe(input.replace(/[*_~|`]/gu, ''));
  });

  it('computes offsets relative to the stripped body', () => {
    expect(p('a **b** c *d*')).toEqual({
      body: 'a b c d',
      ranges: [r(2, 1, 'bold'), r(6, 1, 'italic')],
    });
  });

  it('handles nesting', () => {
    expect(p('**bold _and italic_ here**')).toEqual({
      body: 'bold and italic here',
      ranges: [r(0, 20, 'bold'), r(5, 10, 'italic')],
    });
    const deep = p('||~~*deep*~~||');
    expect(deep.body).toBe('deep');
    expect(deep.ranges).toHaveLength(3);
    expect(deep.ranges).toEqual(
      expect.arrayContaining([r(0, 4, 'spoiler'), r(0, 4, 'strikethrough'), r(0, 4, 'italic')]),
    );
  });

  it('handles triple-asterisk bold italic', () => {
    const { body, ranges } = p('***both***');
    expect(body).toBe('both');
    expect(ranges.map((x) => x.style).sort()).toEqual(['bold', 'italic']);
    expect(ranges.every((x) => x.start === 0 && x.length === 4)).toBe(true);
  });

  it('leaves unmatched markers literal', () => {
    expect(p('**not closed')).toEqual({ body: '**not closed', ranges: [] });
    expect(p('a * b')).toEqual({ body: 'a * b', ranges: [] });
    expect(p('~single~')).toEqual({ body: '~single~', ranges: [] });
    expect(p('`open code')).toEqual({ body: '`open code', ranges: [] });
    expect(p('****')).toEqual({ body: '****', ranges: [] });
  });

  it('follows CommonMark for mixed runs', () => {
    // CommonMark: `**a *b**` → `*<em>a <em>b</em></em>`; the nested same-style
    // range is folded into its parent so no two italic ranges overlap.
    expect(p('**a *b**')).toEqual({ body: '*a b', ranges: [r(1, 3, 'italic')] });
    expect(p('*a *b* c*')).toEqual({ body: 'a b c', ranges: [r(0, 5, 'italic')] });
    // Distinct styles on the same span are kept.
    expect(p('***x***').ranges).toHaveLength(2);
  });

  it('nests emphasis of different lengths correctly', () => {
    expect(p('*a **b** c*')).toEqual({
      body: 'a b c',
      ranges: [r(0, 5, 'italic'), r(2, 1, 'bold')],
    });
    expect(p('**a *b* c**')).toEqual({
      body: 'a b c',
      ranges: [r(0, 5, 'bold'), r(2, 1, 'italic')],
    });
    expect(p('_a **b** c_')).toEqual({
      body: 'a b c',
      ranges: [r(0, 5, 'italic'), r(2, 1, 'bold')],
    });
    const both = p('~~**x**~~');
    expect(both.body).toBe('x');
    expect(both.ranges).toEqual(
      expect.arrayContaining([r(0, 1, 'strikethrough'), r(0, 1, 'bold')]),
    );
  });

  it('applies the rule of 3', () => {
    // `*foo**bar*` is one italic span, not italic + stray bold.
    expect(p('*foo**bar*')).toEqual({ body: 'foo**bar', ranges: [r(0, 8, 'italic')] });
  });

  it('requires non-whitespace inside delimiters', () => {
    expect(p('2 * 3 * 4')).toEqual({ body: '2 * 3 * 4', ranges: [] });
    expect(p('** spaced **')).toEqual({ body: '** spaced **', ranges: [] });
  });

  it('respects word boundaries for underscores and has no __bold__', () => {
    expect(p('snake_case_name')).toEqual({ body: 'snake_case_name', ranges: [] });
    expect(p('__init__.py')).toEqual({ body: '__init__.py', ranges: [] });
    expect(p('__bold__')).toEqual({ body: '__bold__', ranges: [] });
    expect(p('_a_b_')).toEqual({ body: 'a_b', ranges: [r(0, 3, 'italic')] });
    expect(p('use _this_ one')).toEqual({ body: 'use this one', ranges: [r(4, 4, 'italic')] });
  });

  it('allows intraword asterisks', () => {
    expect(p('un*frigging*believable')).toEqual({
      body: 'unfriggingbelievable',
      ranges: [r(2, 8, 'italic')],
    });
  });

  it('handles backslash escapes', () => {
    expect(p('\\*not italic\\*')).toEqual({ body: '*not italic*', ranges: [] });
    expect(p('a \\\\ b')).toEqual({ body: 'a \\ b', ranges: [] });
    expect(p('**a \\*\\* b**')).toEqual({ body: 'a ** b', ranges: [r(0, 6, 'bold')] });
    // A backslash before a non-special character is literal.
    expect(p('C:\\path')).toEqual({ body: 'C:\\path', ranges: [] });
  });

  it('suppresses formatting inside code spans', () => {
    expect(p('`**x** _y_`')).toEqual({ body: '**x** _y_', ranges: [r(0, 9, 'monospace')] });
    expect(p('`a\\*b`')).toEqual({ body: 'a\\*b', ranges: [r(0, 4, 'monospace')] });
    expect(p('**bold `code` bold**')).toEqual({
      body: 'bold code bold',
      ranges: [r(0, 14, 'bold'), r(5, 4, 'monospace')],
    });
  });

  it('supports multi-backtick spans containing backticks', () => {
    expect(p('``a ` b``')).toEqual({ body: 'a ` b', ranges: [r(0, 5, 'monospace')] });
  });

  it('supports fenced code blocks with an optional language tag', () => {
    const input = 'look:\n```ts\nconst x = 1;\n```\ndone';
    expect(p(input)).toEqual({
      body: 'look:\nconst x = 1;\ndone',
      ranges: [r(6, 12, 'monospace')],
    });
    // Only known language ids are stripped; other first lines are content.
    expect(p('```hello\nworld```').body).toBe('hello\nworld');
    expect(p('``` js\ncode```').body).toBe('code');
    expect(p('```\ncode\n```').body).toBe('code');
  });

  it('strips one padding space in inline code', () => {
    expect(p('`` ` ``')).toEqual({ body: '`', ranges: [r(0, 1, 'monospace')] });
    expect(p('` `')).toEqual({ body: ' ', ranges: [r(0, 1, 'monospace')] });
  });

  it('treats URLs as atomic', () => {
    const url = 'https://web.archive.org/web/*/example.com/*';
    expect(p(`see ${url} *now*`)).toEqual({ body: `see ${url} now`, ranges: [r(48, 3, 'italic')] });
    expect(p('https://x.io/a_b_c and _it_')).toEqual({
      body: 'https://x.io/a_b_c and it',
      ranges: [r(23, 2, 'italic')],
    });
  });

  it('keeps || and ~~ literal inside words', () => {
    expect(p('if (a||b) and (c||d)')).toEqual({ body: 'if (a||b) and (c||d)', ranges: [] });
    expect(p('|||a|||')).toEqual({ body: '|||a|||', ranges: [] });
  });

  it('uses UTF-16 code unit offsets (Signal wire units)', () => {
    const { body, ranges } = p('😀 **hi** 👍🏽 _yo_');
    expect(body).toBe('😀 hi 👍🏽 yo');
    // 😀 is two code units; 👍🏽 is four.
    expect(ranges).toEqual([r(3, 2, 'bold'), r(11, 2, 'italic')]);
    expect(body.slice(3, 5)).toBe('hi');
    expect(body.slice(11, 13)).toBe('yo');
  });

  it('keeps mention placeholders in place', () => {
    const { body, ranges } = p('hey **\uFFFC** look');
    expect(body).toBe('hey \uFFFC look');
    expect(ranges).toEqual([r(4, 1, 'bold')]);
  });

  it('spans multiple lines', () => {
    expect(p('**line one\nline two**').ranges).toEqual([r(0, 17, 'bold')]);
  });

  it('never emits overlapping ranges of the same style', () => {
    const samples = [
      '**a *b**',
      '*a **b** c*',
      '~~a ~~b~~ c~~',
      '||a||b||',
      '***a** b*',
      '*a **b***',
      '_a _b_ c_',
    ];
    for (const sample of samples) {
      const { ranges } = p(sample);
      for (const x of ranges) {
        for (const y of ranges) {
          if (x === y || x.style !== y.style) continue;
          const overlap = x.start < y.start + y.length && y.start < x.start + x.length;
          expect(overlap, `${sample}: ${JSON.stringify(ranges)}`).toBe(false);
        }
      }
    }
  });

  it('is linear on pathological input', () => {
    const inputs = [
      '**a *b _c ~~d '.repeat(400), // ~5.6 KB of unclosed openers (was 5.9 s)
      '**a *b _c ~~d ||e **f'.repeat(250),
      '*a'.repeat(3000),
      '*_'.repeat(2000) + '~~||'.repeat(1000),
      '`` ` '.repeat(1000),
      '*'.repeat(20000),
      '_ '.repeat(10000),
      '``a `b '.repeat(3000),
      Array.from({ length: 3000 }, (_, i) => '`'.repeat((i % 50) + 1) + 'x').join(''),
      'int main(int argc, char **argv) { char *p = *argv; if (a || b) x_y = *p; }\n'.repeat(60),
    ];
    for (const input of inputs) {
      const t = performance.now();
      p(input);
      expect(performance.now() - t, `${input.slice(0, 20)}… (${input.length})`).toBeLessThan(60);
    }
  });
});

describe('escapeMarkdown', () => {
  it('round-trips arbitrary text', () => {
    const text = 'a *b* _c_ ~~d~~ ||e|| `f` \\g';
    expect(p(escapeMarkdown(text))).toEqual({ body: text, ranges: [] });
  });
});
