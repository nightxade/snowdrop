/** Where a cursor may rest, and the range a Visual selection covers. Pure. */
import type { Range } from './motions';
import { TextModel } from './text';
import type { VimState } from './types';

/** Clamps grapheme index `i` to a position a Normal-mode cursor may rest on. */
export function clampNormal(m: TextModel, i: number): number {
  const line = m.lineOf(Math.max(0, Math.min(m.n, i)));
  return Math.max(m.lineStart(line), Math.min(i, m.lineLast(line)));
}

/** The nearest UTF-16 offset a Normal-mode cursor may rest on. */
export function normalOffset(text: string, offset: number): number {
  const m = new TextModel(text);
  return m.offset(clampNormal(m, m.indexAt(offset)));
}

/** Grapheme range covered by the Visual selection (whole lines in Visual Line). */
export function visualRange(m: TextModel, s: VimState): Range {
  const a = m.indexAt(s.anchor);
  const c = m.indexAt(s.cursor);
  if (s.mode === 'visual-line') {
    const l1 = m.lineOf(Math.min(a, c));
    const l2 = m.lineOf(Math.max(a, c));
    return { from: m.lineStart(l1), to: m.lineEnd(l2) };
  }
  return { from: Math.min(a, c), to: Math.min(m.n, Math.max(a, c) + 1) };
}

/** Widens a range to the whole lines it touches. */
export function lineRange(m: TextModel, r: Range): Range {
  const l1 = m.lineOf(r.from);
  const l2 = m.lineOf(Math.max(r.from, r.to - 1));
  return { from: m.lineStart(l1), to: m.lineEnd(l2) };
}

export function toNormal(s: VimState, m: TextModel, at: number): VimState {
  return { ...s, mode: 'normal', cursor: m.offset(clampNormal(m, at)), pending: [] };
}
