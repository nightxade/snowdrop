/** Normal-mode commands (x, s, r, ~, J, p, o, i/a/I/A, u, Ctrl+R, ., v…). */
import { repeat } from './dot';
import type { Exec } from './exec';
import { join, operator, put, toggleCase } from './operators';
import { clampNormal } from './positions';
import { redoOnce, snapshot, undoOnce } from './undo';

export function command(
  x: Exec,
  key: string,
  count: number,
  countGiven: boolean,
  arg: string | undefined,
  register: string | null,
): void {
  const { m } = x;
  const from = x.cur;
  const line = m.lineOf(from);
  switch (key) {
    case '<Esc>':
    case '<C-[>':
      x.effects.push({ type: 'escape' });
      return;
    case '<CR>':
      x.effects.push({ type: 'submit' });
      return;
    case '<C-v>':
    case '<C-x>':
      // Swallowed: the block cursor is a selection, and paste/cut would replace it.
      return;
    case 'x':
    case '<Del>': {
      const end = Math.min(m.lineEnd(line), from + count);
      if (end <= from) return;
      x.yank(m.slice(from, end), false, register);
      x.change(() => {
        x.replace(from, end, '');
        x.setCursor(clampNormal(x.m, from));
      });
      return;
    }
    case 'X': {
      const start = Math.max(m.lineStart(line), from - count);
      if (start >= from) return;
      x.yank(m.slice(start, from), false, register);
      x.change(() => {
        x.replace(start, from, '');
        x.setCursor(clampNormal(x.m, start));
      });
      return;
    }
    case 's': {
      const end = Math.min(m.lineEnd(line), from + count);
      const base = snapshot(x.s);
      if (end > from) x.yank(m.slice(from, end), false, register);
      x.replace(from, end, '');
      x.insertAt(from, base);
      return;
    }
    case 'S':
      operator(x, 'c', { kind: 'line' }, count, countGiven, register);
      return;
    case 'C':
      operator(x, 'c', { kind: 'motion', motion: { key: '$' } }, count, countGiven, register);
      return;
    case 'D':
      operator(x, 'd', { kind: 'motion', motion: { key: '$' } }, count, countGiven, register);
      return;
    case 'Y':
      operator(x, 'y', { kind: 'line' }, count, countGiven, register);
      return;
    case 'r': {
      const end = from + count;
      if (end > m.lineEnd(line) || arg === undefined) return;
      const ch = arg === '<CR>' ? '\n' : arg;
      x.change(() => {
        x.replace(from, end, ch === '\n' ? '\n' : ch.repeat(count));
        x.setCursor(ch === '\n' ? x.m.lineStart(line + 1) : from + count - 1);
      });
      return;
    }
    case '~': {
      const end = Math.min(m.lineEnd(line), from + count);
      if (end <= from) return;
      x.change(() => {
        x.replace(from, end, toggleCase(m.slice(from, end)));
        x.setCursor(clampNormal(x.m, end));
      });
      return;
    }
    case 'J':
      x.change(() => {
        join(x, line, Math.max(2, count));
      });
      return;
    case 'p':
    case 'P':
      put(x, key === 'p', count);
      return;
    case 'o':
    case 'O': {
      const base = snapshot(x.s);
      if (key === 'o') {
        const end = m.lineEnd(line);
        x.replace(end, end, '\n');
        x.insertAt(end + 1, base);
      } else {
        const start = m.lineStart(line);
        x.replace(start, start, '\n');
        x.insertAt(start, base);
      }
      return;
    }
    case 'i':
      x.insertAt(from, snapshot(x.s), count);
      return;
    case 'a':
      x.insertAt(Math.min(m.lineEnd(line), from + 1), snapshot(x.s), count);
      return;
    case 'I':
      x.insertAt(m.firstNonBlank(line), snapshot(x.s), count);
      return;
    case 'A':
      x.insertAt(m.lineEnd(line), snapshot(x.s), count);
      return;
    case 'u':
      for (let k = 0; k < count; k++) x.reset(undoOnce(x.s));
      return;
    case '<C-r>':
      for (let k = 0; k < count; k++) x.reset(redoOnce(x.s));
      return;
    case '.':
      repeat(x, countGiven ? count : null);
      return;
    case 'v':
    case 'V':
      x.set({ mode: key === 'v' ? 'visual' : 'visual-line', anchor: x.s.cursor });
      return;
  }
}
