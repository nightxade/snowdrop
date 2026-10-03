/**
 * Insert-mode sessions. Typing in Insert mode is native (the host syncs the
 * field into the state), so a session only remembers what to compare against
 * when it ends: the text on entry (what was typed, for "." and counts) and
 * the state before the entering command (one undo step for both).
 */
import { clampNormal } from './positions';
import { TextModel } from './text';
import type { Snapshot, VimEffect, VimState } from './types';
import { pushUndo } from './undo';

export function startInsert(
  s: VimState,
  at: number,
  keys: readonly string[] | null,
  repeat: number,
  base: Snapshot,
): VimState {
  return {
    ...s,
    mode: 'insert',
    cursor: at,
    goal: null,
    insert: { base, entryText: s.text, keys, repeat },
  };
}

/** What was typed between two texts (a single contiguous insertion, best effort). */
function insertedText(before: string, after: string): string {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let q = 0;
  while (q < max - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  return after.slice(p, after.length - q);
}

/**
 * Ends the session: repeats the typed text for a count ("3ihi<Esc>"), records
 * one undo step and the change for "." (unless replaying), and steps the
 * cursor back onto the last typed character, as Vim does.
 */
export function leaveInsert(
  state: VimState,
  replaying: boolean,
): { state: VimState; effects: VimEffect[] } {
  const session = state.insert;
  let text = state.text;
  let cursor = state.cursor;
  let next: VimState = { ...state };
  if (session) {
    const typed = insertedText(session.entryText, text);
    if (session.repeat > 1 && typed !== '') {
      const extra = typed.repeat(session.repeat - 1);
      text = text.slice(0, cursor) + extra + text.slice(cursor);
      cursor += extra.length;
    }
    next = { ...next, text };
    if (text !== session.base.text) next = { ...next, ...pushUndo(next, session.base) };
    if (session.keys && !replaying)
      next = { ...next, lastChange: { keys: session.keys, ...(typed ? { insert: typed } : {}) } };
  }
  const m = new TextModel(text);
  const i = m.indexAt(cursor);
  const line = m.lineOf(i);
  const back = i > m.lineStart(line) ? i - 1 : i;
  return {
    state: {
      ...next,
      mode: 'normal',
      insert: null,
      cursor: m.offset(clampNormal(m, back)),
      pending: [],
    },
    effects: [{ type: 'mode', mode: 'normal' }],
  };
}
