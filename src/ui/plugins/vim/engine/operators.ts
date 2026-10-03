/**
 * Operators (d c y > <) over motions, text objects and whole lines, plus the
 * line-level edits other commands share (join, put, indent).
 */
import type { Exec } from './exec';
import { textObject, type MotionKind, type Range } from './motions';
import type { Target } from './parse';
import { clampNormal } from './positions';
import { TextModel } from './text';
import { snapshot } from './undo';

export function operator(
  x: Exec,
  op: string,
  target: Target,
  count: number,
  countGiven: boolean,
  register: string | null,
): void {
  const { m } = x;
  const from = x.cur;
  let range: Range;
  let kind: MotionKind;
  if (target.kind === 'line') {
    const line = m.lineOf(from);
    const last = Math.min(m.lineCount - 1, line + count - 1);
    range = { from: m.lineStart(line), to: m.lineEnd(last) };
    kind = 'linewise';
  } else if (target.kind === 'object') {
    const r = textObject(m, from, target.around, target.key, count);
    if (!r) return;
    range = r;
    kind = 'exclusive';
  } else {
    let spec = target.motion;
    // cw on a word changes to its end, not up to the next word (Vim's special case).
    if (
      op === 'c' &&
      (spec.key === 'w' || spec.key === 'W') &&
      m.g[from] !== undefined &&
      !/\s/u.test(m.g[from] ?? ' ')
    )
      spec = { key: spec.key === 'w' ? 'e' : 'E' };
    const r = x.motion(spec, count, countGiven, true);
    if (!r) return;
    kind = r.kind;
    if (kind === 'linewise') {
      const l1 = m.lineOf(Math.min(from, r.to));
      const l2 = m.lineOf(Math.max(from, r.to));
      range = { from: m.lineStart(l1), to: m.lineEnd(l2) };
    } else {
      let a = Math.min(from, r.to);
      // Inclusive, but never past the line break ("d$" on an empty line deletes nothing).
      let b = Math.max(from, r.to) + (kind === 'inclusive' && m.g[r.to] !== '\n' ? 1 : 0);
      // dw on the last word of a line stops at the line end.
      if ((spec.key === 'w' || spec.key === 'W') && m.lineOf(b) > m.lineOf(a) && b > from) {
        b = Math.max(a, m.lineEnd(m.lineOf(a)));
        if (b === a) return;
      }
      a = Math.max(0, a);
      b = Math.min(m.n, b);
      range = { from: a, to: b };
    }
  }
  applyOperator(x, op, range, kind === 'linewise', register);
}

/** d / c / y / > / < over a charwise range or whole lines. */
export function applyOperator(
  x: Exec,
  op: string,
  range: Range,
  linewise: boolean,
  register: string | null,
): void {
  const { m } = x;
  if (linewise) {
    const l1 = m.lineOf(range.from);
    const l2 = m.lineOf(range.to);
    const text = `${m.slice(m.lineStart(l1), m.lineEnd(l2))}\n`;
    if (op === 'y') {
      x.yank(text, true, register);
      if (l1 < m.lineOf(x.cur)) x.setCursor(m.lineStart(l1));
      return;
    }
    if (op === '>' || op === '<') {
      x.change(() => {
        indent(x, l1, l2, op === '>');
        x.setCursor(x.m.firstNonBlank(l1));
      });
      return;
    }
    x.yank(text, true, register);
    if (op === 'd') {
      x.change(() => {
        deleteLines(x, l1, l2);
        const line = Math.min(l1, x.m.lineCount - 1);
        x.setCursor(x.m.firstNonBlank(line));
      });
    } else {
      const base = snapshot(x.s);
      x.replace(m.lineStart(l1), m.lineEnd(l2), '');
      x.insertAt(x.m.lineStart(l1), base);
    }
    return;
  }
  const text = m.slice(range.from, range.to);
  if (op === '>' || op === '<') {
    const l1 = m.lineOf(range.from);
    const l2 = m.lineOf(Math.max(range.from, range.to - 1));
    x.change(() => {
      indent(x, l1, l2, op === '>');
      x.setCursor(x.m.firstNonBlank(l1));
    });
    return;
  }
  x.yank(text, false, register);
  if (op === 'y') {
    x.setCursor(clampNormal(m, range.from));
    return;
  }
  if (op === 'd') {
    x.change(() => {
      x.replace(range.from, range.to, '');
      x.setCursor(clampNormal(x.m, range.from));
    });
  } else {
    const base = snapshot(x.s);
    x.replace(range.from, range.to, '');
    x.insertAt(range.from, base);
  }
}

export function deleteLines(x: Exec, l1: number, l2: number): void {
  const { m } = x;
  const hasNext = l2 + 1 < m.lineCount;
  if (hasNext) x.replace(m.lineStart(l1), m.lineStart(l2 + 1), '');
  else if (l1 > 0) x.replace(m.lineEnd(l1 - 1), m.n, '');
  else x.replace(0, m.n, '');
}

export function indent(x: Exec, l1: number, l2: number, more: boolean): void {
  const lines = x.s.text.split('\n');
  for (let l = l1; l <= l2; l++) {
    const line = lines[l] ?? '';
    if (more) lines[l] = line === '' ? line : `  ${line}`;
    else lines[l] = line.replace(/^(\t| {1,2})/u, '');
  }
  x.set({ text: lines.join('\n') });
}

export function join(x: Exec, line: number, lines: number): void {
  let last = Math.min(x.m.lineCount - 1, line + lines - 1);
  if (last === line) return;
  let cursor = 0;
  for (; last > line; last--) {
    const { m } = x;
    const nl = m.lineEnd(line);
    let next = nl + 1;
    while (next < m.lineEnd(line + 1) && /^[ \t]$/u.test(m.g[next] ?? '')) next++;
    let left = nl;
    while (left > m.lineStart(line) && /^[ \t]$/u.test(m.g[left - 1] ?? '')) left--;
    const nextChar = m.g[next];
    const sep =
      left === m.lineStart(line) || next === m.lineEnd(line + 1) || nextChar === ')' ? '' : ' ';
    x.replace(left, next, sep);
    cursor = left;
  }
  x.setCursor(clampNormal(x.m, cursor));
}

export function put(x: Exec, after: boolean, count: number): void {
  const reg = x.s.register;
  if (reg.text === '') return;
  const { m } = x;
  const from = x.cur;
  const line = m.lineOf(from);
  x.change(() => {
    if (reg.linewise) {
      const block = reg.text.repeat(count);
      if (after) {
        const end = m.lineEnd(line);
        if (end === m.n) {
          // Last line has no newline to insert after.
          x.replace(end, end, `\n${block.slice(0, -1)}`);
        } else x.replace(end + 1, end + 1, block);
        x.setCursor(x.m.firstNonBlank(line + 1));
      } else {
        x.replace(m.lineStart(line), m.lineStart(line), block);
        x.setCursor(x.m.firstNonBlank(line));
      }
      return;
    }
    const text = reg.text.repeat(count);
    const at = after && m.n > 0 && from < m.lineEnd(line) ? from + 1 : from;
    x.replace(at, at, text);
    const inserted = new TextModel(text).n;
    x.setCursor(clampNormal(x.m, at + inserted - 1));
  });
}

export function toggleCase(text: string): string {
  return Array.from(text, (c) => {
    const lower = c.toLowerCase();
    return c === lower ? c.toUpperCase() : lower;
  }).join('');
}
