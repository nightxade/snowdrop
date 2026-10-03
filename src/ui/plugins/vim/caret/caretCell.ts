/**
 * Where to draw Vim's block cursor in a textarea, as a pure function of the
 * text, the cursor offset and a few measurements (`CaretMeasure`). The DOM
 * side (`mirror.ts`) measures with a hidden copy of the field; tests pass
 * a fake.
 *
 * Coordinates are in the field's padding box, before scrolling: (0, 0) is
 * the top-left corner inside its border. The caller subtracts the scroll
 * offset when it draws.
 */
import { TextModel } from '../engine/text';

/** A measured inline box: the cell's glyph, or an empty marker for an empty cell. */
export interface MeasuredBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CaretMeasure {
  /**
   * Lays out `text` like the field does and measures the UTF-16 range
   * `[start, end)` in place. An empty range measures a zero-width marker at
   * `start` (where the next character would go).
   */
  box(text: string, start: number, end: number): MeasuredBox;
  /** The field's line height in px (one row of text). */
  lineHeight: number;
  /** Top padding of the field: lines start here. */
  paddingTop: number;
  /** Width of an empty cell (end of line, blank line, empty field): the font's "0" (1ch). */
  cellWidth: number;
}

export interface CaretCell {
  /** UTF-16 range of the character under the cursor; start === end for an empty cell. */
  start: number;
  end: number;
  /** The character to draw inside the block ('' for an empty cell or a blank). */
  char: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A cell narrower than this (a combining mark, a zero-width space) gets the empty-cell width. */
const MIN_WIDTH = 2;
/**
 * Narrow glyphs (i, l, punctuation) get a block at least this share of 1ch,
 * centred on the glyph, so the cursor never reads as a thin bar.
 */
const NARROW = 0.6;

/** Graphemes drawn as nothing: line breaks and whitespace. */
const BLANK = /^\s+$/u;

/**
 * The block cursor's cell for the cursor at UTF-16 `offset` in `text`.
 * The offset snaps back to the start of its grapheme (an emoji ZWJ sequence
 * or a flag is one cell). Past the last character, on a "\n" (end of line,
 * blank line) or in an empty field the cell is empty: it sits where the
 * next character would go and is one `cellWidth` wide. Rows snap to the
 * line grid, so a fallback-font glyph (emoji) with taller ascent doesn't
 * nudge the block off its row. The drawn character is centred in the
 * block, which only differs from the glyph's own box for narrow glyphs.
 */
export function caretCell(text: string, offset: number, measure: CaretMeasure): CaretCell {
  const model = new TextModel(text);
  const i = model.indexAt(Math.max(0, Math.min(text.length, offset)));
  const start = model.offset(i);
  const grapheme = i < model.n ? (model.g[i] ?? '') : '';
  const empty = grapheme === '' || grapheme === '\n' || grapheme === '\r\n';
  const end = empty ? start : model.offset(i + 1);
  const box = measure.box(text, start, end);
  const lineHeight = Math.max(1, measure.lineHeight);
  // The row the glyph's middle falls in.
  const row = Math.max(0, Math.floor((box.top + box.height / 2 - measure.paddingTop) / lineHeight));
  let width = empty || box.width < MIN_WIDTH ? Math.max(box.width, measure.cellWidth) : box.width;
  let left = box.left;
  const narrow = measure.cellWidth * NARROW;
  if (width < narrow) {
    left -= (narrow - width) / 2;
    width = narrow;
  }
  return {
    start,
    end,
    char: empty || BLANK.test(grapheme) ? '' : grapheme,
    left,
    top: measure.paddingTop + row * lineHeight,
    width,
    height: lineHeight,
  };
}

/** Whether two cells would draw the same block (so a re-render can be skipped). */
export function sameCell(a: CaretCell | null, b: CaretCell | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.char === b.char &&
    a.start === b.start &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
