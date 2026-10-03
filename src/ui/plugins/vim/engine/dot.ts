/** "." — repeat the last change, replaying its keys and then the text typed in Insert mode. */
import type { Exec } from './exec';
import { leaveInsert } from './insert';
import type { VimState } from './types';

/** "." replays the last change's keys, then its typed text; a count replaces the original. */
export function repeat(x: Exec, count: number | null): void {
  const last = x.s.lastChange;
  if (!last) return;
  let keys = [...last.keys];
  if (count !== null) {
    const regLen = keys[0] === '"' ? 2 : 0;
    let j = regLen;
    while (j < keys.length && /^[0-9]$/u.test(keys[j] ?? '') && !(j === regLen && keys[j] === '0'))
      j++;
    keys = [...keys.slice(0, regLen), ...String(count).split(''), ...keys.slice(j)];
  }
  let state: VimState = { ...x.s, pending: [] };
  for (const k of keys) {
    const r = x.feed(state, k, true);
    state = r.state;
    x.effects.push(...r.effects.filter((e) => e.type === 'clipboard'));
  }
  if (state.mode === 'insert') {
    const typed = last.insert ?? '';
    const text = state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor);
    state = leaveInsert({ ...state, text, cursor: state.cursor + typed.length }, true).state;
  }
  x.reset({ ...state, lastChange: last });
}
