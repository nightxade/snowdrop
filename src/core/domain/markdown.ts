/**
 * Markdown-lite → Signal body ranges.
 *
 * Signal carries formatting as `(start, length, style)` ranges over a plain
 * body, not as markup. Converting the composer's markdown into ranges before
 * sending means recipients on the official apps see *native* formatting and
 * never stray asterisks.
 *
 * Supported syntax (a deliberately small, chat-oriented subset):
 *   **bold**  __bold__  *italic*  _italic_  ~~strike~~  ||spoiler||
 *   `code`  ``code with ` inside``  ```fenced\ncode```
 *   \* (backslash escapes any of  \ * _ ~ | ` )
 *
 * Rules:
 * - Openers must be followed by non-whitespace; closers preceded by
 *   non-whitespace, so `2 * 3 * 4` stays literal.
 * - Underscore delimiters respect word boundaries (`snake_case_name` is literal).
 * - Unmatched delimiters are left as literal text.
 * - Code spans are atomic: nothing inside them is interpreted.
 * - An unclosed inner delimiter never swallows an outer closer:
 *   `**a *b**` → bold("a *b").
 * - All indices are UTF-16 code units, which is what Signal expects and what
 *   JavaScript string indices already are, so no conversion is needed.
 */
import type { BodyRange, TextStyle } from './types';

type Delimiter = '**' | '__' | '*' | '_' | '~~' | '||';

const DELIMITER_STYLE: Record<Delimiter, TextStyle> = {
  '**': 'bold',
  __: 'bold',
  '*': 'italic',
  _: 'italic',
  '~~': 'strikethrough',
  '||': 'spoiler',
};

/** Longest first so `**` wins over `*`. */
const DELIMITERS: readonly Delimiter[] = ['**', '__', '~~', '||', '*', '_'];

const ESCAPABLE = new Set(['\\', '*', '_', '~', '|', '`']);

export interface ParsedMarkdown {
  body: string;
  ranges: BodyRange[];
}

const isWhitespace = (ch: string | undefined): boolean => ch === undefined || /\s/u.test(ch);
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isUnderscore = (d: Delimiter): boolean => d === '_' || d === '__';

interface ParseResult {
  /** Input index just past the consumed closer (or where parsing stopped). */
  end: number;
  closed: boolean;
}

class Parser {
  private out = '';
  private ranges: BodyRange[] = [];
  /** Memo of (position, open-delimiter stack) pairs already known not to close. */
  private readonly failed = new Set<string>();

  constructor(private readonly src: string) {}

  run(): ParsedMarkdown {
    this.parse(0, []);
    const ranges = [...this.ranges].sort((a, b) => a.start - b.start || b.length - a.length);
    return { body: this.out, ranges };
  }

  private delimiterAt(i: number): Delimiter | null {
    for (const d of DELIMITERS) if (this.src.startsWith(d, i)) return d;
    return null;
  }

  private canOpen(d: Delimiter, i: number): boolean {
    const after = this.src[i + d.length];
    if (isWhitespace(after)) return false;
    if (isUnderscore(d) && isWordChar(this.src[i - 1])) return false;
    return true;
  }

  private canClose(d: Delimiter, i: number, contentStart: number): boolean {
    if (i <= contentStart) return false;
    if (!this.src.startsWith(d, i)) return false;
    if (isWhitespace(this.src[i - 1])) return false;
    if (isUnderscore(d) && isWordChar(this.src[i + d.length])) return false;
    return true;
  }

  /** Length of the run of identical characters starting at `i`. */
  private runLength(i: number): number {
    const ch = this.src[i];
    let n = 0;
    while (this.src[i + n] === ch) n++;
    return n;
  }

  /**
   * Parses from `start` until the innermost open delimiter closes (success) or
   * until end of input / an ancestor's closer (failure; the caller rolls back
   * and treats its opener as literal text).
   */
  private parse(start: number, stack: readonly Delimiter[]): ParseResult {
    const src = this.src;
    const current = stack.at(-1);
    const ancestors = stack.slice(0, -1);
    let i = start;

    while (i < src.length) {
      const ch = src[i] as string;

      if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1] as string)) {
        this.out += src.charAt(i + 1);
        i += 2;
        continue;
      }

      if (ch === '`') {
        i = this.codeSpan(i);
        continue;
      }

      if (current !== undefined) {
        const selfCloses = this.canClose(current, i, start);
        const ancestor = ancestors.find((a) => a !== current && this.canClose(a, i, start));
        // `***x***` closes both italic and bold; `**a *b**` must close the bold,
        // leaving the inner `*` literal. The run length disambiguates.
        if (
          selfCloses &&
          (ancestor === undefined || this.runLength(i) >= current.length + ancestor.length)
        ) {
          return { end: i + current.length, closed: true };
        }
        if (ancestor !== undefined) return { end: i, closed: false };
      }

      const d = this.delimiterAt(i);
      if (d !== null) {
        const end = !stack.includes(d) && this.canOpen(d, i) ? this.tryStyled(d, i, stack) : null;
        if (end !== null) {
          i = end;
        } else {
          this.out += d;
          i += d.length;
        }
        continue;
      }

      this.out += ch;
      i += 1;
    }
    return { end: i, closed: false };
  }

  /** Attempts a styled span opened by `d` at `i`; returns the index after it, or null. */
  private tryStyled(d: Delimiter, i: number, stack: readonly Delimiter[]): number | null {
    const nextStack = [...stack, d];
    const memoKey = `${i}|${nextStack.join(' ')}`;
    if (this.failed.has(memoKey)) return null;

    const outMark = this.out.length;
    const rangeMark = this.ranges.length;
    const result = this.parse(i + d.length, nextStack);

    if (result.closed && this.out.length > outMark) {
      this.ranges.push({
        start: outMark,
        length: this.out.length - outMark,
        style: DELIMITER_STYLE[d],
      });
      return result.end;
    }
    this.failed.add(memoKey);
    this.out = this.out.slice(0, outMark);
    this.ranges.length = rangeMark;
    return null;
  }

  /** Emits a code span starting at the backtick run at `i`; returns the next index. */
  private codeSpan(i: number): number {
    const src = this.src;
    let n = 0;
    while (src[i + n] === '`') n++;
    const fence = '`'.repeat(n);

    let search = i + n;
    let close = -1;
    while (search < src.length) {
      const at = src.indexOf(fence, search);
      if (at === -1) break;
      let runEnd = at;
      while (src[runEnd] === '`') runEnd++;
      if (runEnd - at === n) {
        close = at;
        break;
      }
      search = runEnd;
    }

    if (close === -1) {
      this.out += fence;
      return i + n;
    }

    let content = src.slice(i + n, close);
    if (n >= 3) {
      // Fenced block: drop an optional language tag line and edge newlines.
      content = content.replace(/^[\w+#.-]*\n/u, '').replace(/\n$/u, '');
    }
    if (content.length === 0) {
      this.out += src.slice(i, close + n);
      return close + n;
    }
    this.ranges.push({ start: this.out.length, length: content.length, style: 'monospace' });
    this.out += content;
    return close + n;
  }
}

export function parseMarkdownToRanges(text: string): ParsedMarkdown {
  return new Parser(text).run();
}

/** Escapes text so it round-trips through parseMarkdownToRanges unchanged. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~|`]/gu, (m) => `\\${m}`);
}
