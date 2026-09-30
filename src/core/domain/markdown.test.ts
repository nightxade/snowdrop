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
    ['__bold__', 'bold'],
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

  it('does not let an unclosed inner marker swallow the outer closer', () => {
    expect(p('**a *b**')).toEqual({ body: 'a *b', ranges: [r(0, 4, 'bold')] });
  });

  it('requires non-whitespace inside delimiters', () => {
    expect(p('2 * 3 * 4')).toEqual({ body: '2 * 3 * 4', ranges: [] });
    expect(p('** spaced **')).toEqual({ body: '** spaced **', ranges: [] });
  });

  it('respects word boundaries for underscores', () => {
    expect(p('snake_case_name')).toEqual({ body: 'snake_case_name', ranges: [] });
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
    expect(p('**a \\** b**')).toEqual({ body: 'a ** b', ranges: [r(0, 6, 'bold')] });
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

  it('stays fast on pathological input', () => {
    const evil = '*_'.repeat(400) + '~~||'.repeat(200);
    const t = performance.now();
    const out = p(evil);
    expect(performance.now() - t).toBeLessThan(500);
    expect(out.body.length).toBeGreaterThan(0);
  });
});

describe('escapeMarkdown', () => {
  it('round-trips arbitrary text', () => {
    const text = 'a *b* _c_ ~~d~~ ||e|| `f` \\g';
    expect(p(escapeMarkdown(text))).toEqual({ body: text, ranges: [] });
  });
});
