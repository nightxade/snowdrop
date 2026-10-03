import { describe, expect, it } from 'vitest';
import { TextModel } from '../engine/text';
import { caretCell, sameCell, type CaretMeasure } from './caretCell';

const LINE = 20;
const PAD = 5;
const CH = 9;

/**
 * A fake field: graphemes are 10px wide ("W" 14px, emoji 22px, combining
 * marks 0), lines are LINE tall from PAD, and a grapheme that doesn't fit
 * in `width` wraps to the next row (character wrap: enough for the maths).
 * Emoji glyphs come from a taller fallback font: their box sits 3px high.
 */
function fakeMeasure(width = 100): CaretMeasure {
  const widthOf = (g: string) =>
    g === 'W' ? 14 : /\p{Extended_Pictographic}/u.test(g) ? 22 : /^\p{M}$/u.test(g) ? 0 : 10;
  return {
    lineHeight: LINE,
    paddingTop: PAD,
    cellWidth: CH,
    box(text, start, end) {
      const m = new TextModel(text);
      let x = 0;
      let row = 0;
      for (let i = 0; i < m.n; i++) {
        const g = m.g[i]!;
        const w = g === '\n' ? 0 : widthOf(g);
        if (g !== '\n' && x + w > width) {
          x = 0;
          row++;
        }
        if (m.offset(i) === start) {
          const emoji = /\p{Extended_Pictographic}/u.test(g);
          return {
            left: x,
            top: PAD + row * LINE + (emoji ? -1 : 2),
            width: end > start ? w : 0,
            height: emoji ? 22 : 16,
          };
        }
        if (g === '\n') {
          x = 0;
          row++;
        } else x += w;
      }
      return { left: x, top: PAD + row * LINE + 2, width: 0, height: 16 };
    },
  };
}

describe('caretCell', () => {
  const measure = fakeMeasure();

  it('covers the character under the cursor', () => {
    expect(caretCell('hello', 1, measure)).toEqual({
      start: 1,
      end: 2,
      char: 'e',
      left: 10,
      top: PAD,
      width: 10,
      height: LINE,
    });
    expect(caretCell('aWb', 1, measure)).toMatchObject({ char: 'W', left: 10, width: 14 });
  });

  it('is an empty 1ch cell in an empty field', () => {
    expect(caretCell('', 0, measure)).toEqual({
      start: 0,
      end: 0,
      char: '',
      left: 0,
      top: PAD,
      width: CH,
      height: LINE,
    });
  });

  it('sits after the last character at the end of the text', () => {
    expect(caretCell('abc', 3, measure)).toMatchObject({ char: '', left: 30, width: CH, top: PAD });
  });

  it('sits at the end of a line, on its "\\n"', () => {
    expect(caretCell('ab\ncd', 2, measure)).toMatchObject({
      start: 2,
      end: 2,
      char: '',
      left: 20,
      top: PAD,
      width: CH,
    });
  });

  it('shows on a blank line between lines', () => {
    expect(caretCell('one\n\ntwo', 4, measure)).toMatchObject({
      char: '',
      left: 0,
      top: PAD + LINE,
      width: CH,
    });
    // And on the next line's first character.
    expect(caretCell('one\n\ntwo', 5, measure)).toMatchObject({ char: 't', top: PAD + 2 * LINE });
  });

  it('shows on the empty line after a trailing newline', () => {
    expect(caretCell('one\n', 4, measure)).toMatchObject({ char: '', left: 0, top: PAD + LINE });
  });

  it('follows soft-wrapped lines', () => {
    // 10 characters fill a 100px row; the 11th wraps.
    const text = 'abcdefghijkl';
    expect(caretCell(text, 9, measure)).toMatchObject({ char: 'j', left: 90, top: PAD });
    expect(caretCell(text, 10, measure)).toMatchObject({ char: 'k', left: 0, top: PAD + LINE });
    expect(caretCell(text, 12, measure)).toMatchObject({ char: '', left: 20, top: PAD + LINE });
  });

  it('treats an emoji ZWJ sequence as one cell, snapping into it to its start', () => {
    const family = '👩‍👩‍👧';
    const text = `a${family}b`;
    const cell = caretCell(text, 1, measure);
    expect(cell).toMatchObject({ start: 1, end: 1 + family.length, char: family, width: 22 });
    // A taller fallback-font glyph still lands on the text row.
    expect(cell.top).toBe(PAD);
    expect(cell.height).toBe(LINE);
    // An offset inside the sequence (between surrogates or after a ZWJ) snaps back.
    expect(caretCell(text, 3, measure)).toMatchObject({ start: 1, char: family });
    expect(caretCell(text, 1 + family.length, measure)).toMatchObject({ char: 'b', left: 32 });
  });

  it('keeps combining marks with their base and flags as one cell', () => {
    expect(caretCell('éx', 0, measure)).toMatchObject({ end: 2, char: 'é' });
    expect(caretCell('🇫🇷!', 0, measure)).toMatchObject({ end: 4, char: '🇫🇷' });
  });

  it('draws blanks as an empty block of their own width, never narrower than 2px', () => {
    expect(caretCell('a b', 1, measure)).toMatchObject({ char: '', width: 10, end: 2 });
    // A lone zero-width mark gets the empty-cell width.
    expect(caretCell('́', 0, measure)).toMatchObject({ width: CH });
  });

  it('widens narrow glyphs to 0.6ch, centred on the glyph', () => {
    const thin: CaretMeasure = {
      ...measure,
      box: (t, s, e) => ({ ...measure.box(t, s, e), width: 3 }),
    };
    const cell = caretCell('il', 1, thin);
    expect(cell.width).toBeCloseTo(CH * 0.6);
    expect(cell.left + cell.width / 2).toBeCloseTo(10 + 1.5);
  });

  it('clamps out-of-range offsets', () => {
    expect(caretCell('ab', 99, measure)).toMatchObject({ start: 2, char: '' });
    expect(caretCell('ab', -4, measure)).toMatchObject({ start: 0, char: 'a' });
  });

  it('compares cells by what they draw', () => {
    const a = caretCell('ab', 0, measure);
    expect(sameCell(a, { ...a, left: a.left + 0.1 })).toBe(true);
    expect(sameCell(a, { ...a, left: a.left + 3 })).toBe(false);
    expect(sameCell(a, null)).toBe(false);
    expect(sameCell(null, null)).toBe(true);
  });
});
