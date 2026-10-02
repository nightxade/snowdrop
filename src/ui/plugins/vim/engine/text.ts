/**
 * Text as the Vim engine sees it: a sequence of grapheme clusters (so a ZWJ
 * emoji family or a flag is one "character" for h/l/x/r) split into logical
 * lines at "\n". Positions are grapheme indices; `offset(i)` converts back to
 * UTF-16 offsets for the textarea. Pure, no DOM.
 */

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function splitGraphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

export type CharClass = 0 | 1 | 2;

const BLANK = /^\s/u;
const WORD = /^[\p{L}\p{N}\p{M}_]/u;

/** 0 = blank, 1 = keyword (letters, digits, _), 2 = other non-blank. `big` (WORD) merges 1 and 2. */
export function charClass(g: string | undefined, big = false): CharClass {
  if (g === undefined || BLANK.test(g)) return 0;
  if (big) return 1;
  return WORD.test(g) ? 1 : 2;
}

export class TextModel {
  /** Grapheme clusters. */
  readonly g: readonly string[];
  /** UTF-16 offset of each grapheme start; pos[n] = text.length. */
  readonly pos: readonly number[];
  readonly n: number;
  /** Grapheme index where each line starts. */
  readonly lineStarts: readonly number[];

  constructor(readonly text: string) {
    const g = splitGraphemes(text);
    const pos: number[] = [];
    const starts = [0];
    let at = 0;
    for (const [i, cluster] of g.entries()) {
      pos.push(at);
      at += cluster.length;
      if (cluster === '\n') starts.push(i + 1);
    }
    pos.push(at);
    this.g = g;
    this.pos = pos;
    this.n = g.length;
    this.lineStarts = starts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  offset(i: number): number {
    return this.pos[Math.max(0, Math.min(this.n, i))] ?? this.text.length;
  }

  /** Grapheme index for a UTF-16 offset (snaps back to the cluster start). */
  indexAt(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.text.length) return this.n;
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.pos[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineOf(i: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineStart(line: number): number {
    return this.lineStarts[Math.max(0, Math.min(this.lineCount - 1, line))] ?? 0;
  }

  /** Index of the line's "\n" (or n for the last line): one past its last character. */
  lineEnd(line: number): number {
    const next = this.lineStarts[line + 1];
    return next === undefined ? this.n : next - 1;
  }

  /** Last character a Normal-mode cursor may rest on (the start, on an empty line). */
  lineLast(line: number): number {
    return Math.max(this.lineStart(line), this.lineEnd(line) - 1);
  }

  firstNonBlank(line: number): number {
    const end = this.lineEnd(line);
    let i = this.lineStart(line);
    while (i < end && charClass(this.g[i]) === 0) i++;
    return i;
  }

  column(i: number): number {
    return i - this.lineStart(this.lineOf(i));
  }

  /** Text of graphemes [from, to). */
  slice(from: number, to: number): string {
    return this.text.slice(this.offset(from), this.offset(to));
  }

  isEmptyLine(line: number): boolean {
    return this.lineStart(line) === this.lineEnd(line);
  }
}
