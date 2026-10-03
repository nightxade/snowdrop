/** Visual and Visual Line mode: moving the selection, text objects and the commands that act on it. */
import type { Exec } from './exec';
import type { MotionSpec } from './parse';
import { applyOperator, indent, join, toggleCase } from './operators';
import { clampNormal, lineRange, toNormal, visualRange } from './positions';
import { textObject } from './motions';

export function moveVisual(x: Exec, spec: MotionSpec, count: number, countGiven: boolean): void {
  const r = x.motion(spec, count, countGiven, false);
  if (!r) return;
  x.set({
    cursor: x.m.offset(Math.min(r.to, Math.max(0, x.m.n - 1))),
    goal: r.goal === undefined ? x.s.goal : r.goal,
  });
}

export function selectObject(x: Exec, around: 'i' | 'a', key: string, count: number): void {
  const r = textObject(x.m, x.cur, around, key, count);
  if (!r || r.to <= r.from) return;
  x.set({ mode: 'visual', anchor: x.m.offset(r.from), cursor: x.m.offset(r.to - 1) });
}

export function visualCommand(
  x: Exec,
  key: string,
  count: number,
  arg: string | undefined,
  register: string | null,
): void {
  const { m } = x;
  const lineMode = x.s.mode === 'visual-line';
  const range = visualRange(m, x.s);
  const exitTo = (i: number) => {
    x.s = toNormal(x.s, x.m, i);
  };
  switch (key) {
    case '<Esc>':
    case '<C-[>':
    case '<CR>':
      exitTo(x.cur);
      return;
    case '<C-v>':
    case '<C-x>':
      return;
    case 'v':
    case 'V': {
      const target = key === 'v' ? 'visual' : 'visual-line';
      if (x.s.mode === target) exitTo(x.cur);
      else x.set({ mode: target });
      return;
    }
    case 'o':
    case 'O':
      x.set({ anchor: x.s.cursor, cursor: x.s.anchor });
      return;
    case 'y':
    case 'Y': {
      const linewise = lineMode || key === 'Y';
      const r = key === 'Y' ? lineRange(m, range) : range;
      x.s = { ...x.s, mode: 'normal' };
      applyOperator(x, 'y', r, linewise, register);
      x.setCursor(clampNormal(x.m, linewise ? x.m.lineStart(m.lineOf(range.from)) : range.from));
      return;
    }
    case 'd':
    case 'x':
    case '<Del>':
    case 'X':
    case 'D':
    case 'c':
    case 's':
    case 'C':
    case 'S':
    case 'R': {
      const linewise = lineMode || ['X', 'D', 'C', 'S', 'R'].includes(key);
      const op = ['c', 's', 'C', 'S', 'R'].includes(key) ? 'c' : 'd';
      x.s = { ...x.s, mode: 'normal', cursor: m.offset(range.from) };
      applyOperator(x, op, linewise ? lineRange(m, range) : range, linewise, register);
      return;
    }
    case '>':
    case '<': {
      const l1 = m.lineOf(range.from);
      const l2 = m.lineOf(Math.max(range.from, range.to - 1));
      x.s = { ...x.s, mode: 'normal' };
      x.change(() => {
        for (let k = 0; k < count; k++) indent(x, l1, l2, key === '>');
        x.setCursor(x.m.firstNonBlank(l1));
      }, false);
      return;
    }
    case '~':
    case 'u':
    case 'U': {
      const fn =
        key === '~'
          ? toggleCase
          : key === 'u'
            ? (t: string) => t.toLowerCase()
            : (t: string) => t.toUpperCase();
      x.s = { ...x.s, mode: 'normal' };
      x.change(() => {
        x.replace(range.from, range.to, fn(m.slice(range.from, range.to)));
        x.setCursor(clampNormal(x.m, range.from));
      }, false);
      return;
    }
    case 'r': {
      if (arg === undefined) return;
      x.s = { ...x.s, mode: 'normal' };
      const replaced = m.g
        .slice(range.from, range.to)
        .map((g) => (g === '\n' ? g : arg))
        .join('');
      x.change(() => {
        x.replace(range.from, range.to, replaced);
        x.setCursor(clampNormal(x.m, range.from));
      }, false);
      return;
    }
    case 'J': {
      const l1 = m.lineOf(range.from);
      const l2 = m.lineOf(Math.max(range.from, range.to - 1));
      x.s = { ...x.s, mode: 'normal' };
      x.change(() => {
        join(x, l1, Math.max(2, l2 - l1 + 1));
      }, false);
      return;
    }
    case 'p':
    case 'P': {
      const reg = x.s.register;
      const r = lineMode ? lineRange(m, range) : range;
      const removed = m.slice(r.from, r.to);
      x.s = { ...x.s, mode: 'normal' };
      x.change(() => {
        const insert =
          reg.linewise && !lineMode
            ? `\n${reg.text}`
            : !reg.linewise && lineMode
              ? reg.text
              : reg.linewise
                ? reg.text.slice(0, -1)
                : reg.text;
        x.replace(r.from, r.to, insert.repeat(count));
        x.setCursor(clampNormal(x.m, r.from));
      }, false);
      if (key === 'p') x.yank(lineMode ? `${removed}\n` : removed, lineMode, register);
      return;
    }
  }
}
