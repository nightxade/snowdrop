/**
 * Undo and redo: each change pushes a snapshot of the text and cursor before
 * it. Insert mode is one step together with the command that entered it
 * (see insert.ts). Pure functions over VimState.
 */
import { clampNormal } from './positions';
import { TextModel } from './text';
import type { Snapshot, VimState } from './types';

const UNDO_LIMIT = 200;

export function snapshot(s: VimState): Snapshot {
  return { text: s.text, cursor: s.cursor };
}

/** Records `snap` as an undo step and clears redo (a new change forks history). */
export function pushUndo(s: VimState, snap: Snapshot): Pick<VimState, 'undo' | 'redo'> {
  return { undo: [...s.undo, snap].slice(-UNDO_LIMIT), redo: [] };
}

/** Steps back once; the same state when there's nothing to undo. */
export function undoOnce(s: VimState): VimState {
  const prev = s.undo.at(-1);
  if (!prev) return s;
  const m = new TextModel(prev.text);
  return {
    ...s,
    text: prev.text,
    undo: s.undo.slice(0, -1),
    redo: [...s.redo, snapshot(s)],
    cursor: m.offset(clampNormal(m, m.indexAt(prev.cursor))),
    goal: null,
  };
}

/** Steps forward once; the same state when there's nothing to redo. */
export function redoOnce(s: VimState): VimState {
  const next = s.redo.at(-1);
  if (!next) return s;
  const current = snapshot(s);
  const m = new TextModel(next.text);
  return {
    ...s,
    text: next.text,
    redo: s.redo.slice(0, -1),
    undo: [...s.undo, current],
    cursor: m.offset(clampNormal(m, m.indexAt(Math.min(current.cursor, next.text.length)))),
    goal: null,
  };
}
