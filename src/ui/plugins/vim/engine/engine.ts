/**
 * A small, textarea-agnostic Vim engine. `feed(state, token)` returns the
 * next state plus effects for the host (submit, escape, clipboard). The host
 * mirrors `state.text` and `selectionFor(state)` into the real field and
 * calls `sync` with the field's contents before each key, so typing in
 * Insert mode stays native (IME, autocomplete, spellcheck, native undo).
 *
 * Supported: Normal / Insert / Visual / Visual Line; motions h j k l w b e
 * W B E 0 ^ $ gg G f F t T ; , %; operators d c y > < with motions and text
 * objects (iw aw iW aW i" a" i' a' i` a` i( a( ib i[ a[ i{ a{ iB i< a<);
 * dd cc yy >> << D C Y x X s S r ~ J p P o O i a I A u Ctrl+R and "." —
 * all with counts. Registers: one unnamed register; "+ / "* also copy to
 * the clipboard (an effect). Pure: no DOM, no timers.
 *
 * This module is the public API. The work is split by concern: parse.ts
 * (keys → command), exec.ts (editing primitives), normal.ts, visual.ts,
 * operators.ts, insert.ts (Insert sessions), undo.ts and dot.ts (".").
 */
import { Exec } from './exec';
import { leaveInsert, startInsert } from './insert';
import { command } from './normal';
import { operator } from './operators';
import { parseNormal, parseVisual, passesThrough, type Parsed } from './parse';
import { clampNormal, normalOffset, visualRange } from './positions';
import { TextModel } from './text';
import type { FeedResult, FieldState, Mode, VimState } from './types';
import { snapshot } from './undo';
import { moveVisual, selectObject, visualCommand } from './visual';

export type { Change, FeedResult, FieldState, Mode, Register, VimEffect, VimState } from './types';

export function createVimState(text = '', cursor = text.length, mode: Mode = 'insert'): VimState {
  const base: VimState = {
    text,
    cursor: Math.max(0, Math.min(text.length, cursor)),
    anchor: 0,
    mode: 'normal',
    pending: [],
    register: { text: '', linewise: false },
    undo: [],
    redo: [],
    lastChange: null,
    lastFind: null,
    goal: null,
    insert: null,
  };
  return mode === 'insert'
    ? startInsert(base, base.cursor, null, 1, snapshot(base))
    : { ...base, mode, cursor: mode === 'normal' ? normalOffset(text, base.cursor) : base.cursor };
}

// ─── Host bridge ────────────────────────────────────────────────────────

/** The selection the host should show: a one-character block in Normal mode. */
export function selectionFor(state: VimState): { start: number; end: number } {
  const m = new TextModel(state.text);
  switch (state.mode) {
    case 'insert':
      return { start: state.cursor, end: state.cursor };
    case 'normal': {
      const i = m.indexAt(state.cursor);
      const onChar = i < m.n && m.g[i] !== '\n';
      return { start: state.cursor, end: onChar ? m.offset(i + 1) : state.cursor };
    }
    case 'visual': {
      const r = visualRange(m, state);
      return { start: m.offset(r.from), end: m.offset(r.to) };
    }
    case 'visual-line': {
      const r = visualRange(m, state);
      return { start: m.offset(r.from), end: m.offset(r.to) };
    }
  }
}

/**
 * Adopts the field's contents: text typed natively, a click that moved the
 * caret, a mouse selection (which becomes Visual mode, as in Vim with the
 * mouse), a send that cleared the field.
 */
export function sync(state: VimState, field: FieldState): VimState {
  const shown = selectionFor(state);
  const sameText = field.text === state.text;
  if (sameText && field.selectionStart === shown.start && field.selectionEnd === shown.end)
    return state;
  const m = new TextModel(field.text);
  const start = Math.min(field.selectionStart, field.selectionEnd);
  const end = Math.max(field.selectionStart, field.selectionEnd);
  if (state.mode === 'insert') return { ...state, text: field.text, cursor: end };
  if (!sameText && state.mode !== 'normal') {
    return {
      ...state,
      text: field.text,
      mode: 'normal',
      cursor: m.offset(clampNormal(m, m.indexAt(start))),
      pending: [],
    };
  }
  const startIdx = m.indexAt(start);
  const endIdx = m.indexAt(end);
  if (endIdx - startIdx > 1) {
    return {
      ...state,
      text: field.text,
      mode: 'visual',
      anchor: m.offset(startIdx),
      cursor: m.offset(endIdx - 1),
      pending: [],
    };
  }
  if (state.mode !== 'normal' && sameText) {
    // A click while in Visual mode collapses to Normal at the click.
    return { ...state, mode: 'normal', cursor: m.offset(clampNormal(m, startIdx)), pending: [] };
  }
  return { ...state, text: field.text, cursor: m.offset(clampNormal(m, startIdx)) };
}

/**
 * Enters Insert mode from outside (the host focusing the composer with
 * "i"/"a"/"A"/"I", or IME input starting in Normal mode). `keys` makes the
 * session repeatable with "." as if those keys had been typed.
 */
export function enterInsert(
  state: VimState,
  where: 'cursor' | 'after' | 'end' | 'start' = 'cursor',
  keys: readonly string[] | null = null,
): VimState {
  const m = new TextModel(state.text);
  const i = m.indexAt(state.cursor);
  let at = state.cursor;
  if (where === 'end') at = state.text.length;
  else if (where === 'start') at = 0;
  else if (where === 'after' && state.mode !== 'insert')
    at = m.offset(Math.min(m.lineEnd(m.lineOf(i)), i + 1));
  if (state.mode === 'insert') return { ...state, cursor: at };
  return startInsert({ ...state, pending: [] }, at, keys, 1, snapshot(state));
}

// ─── Feeding keys ───────────────────────────────────────────────────────

export function feed(state: VimState, token: string): FeedResult {
  return feedInternal(state, token, false);
}

function feedInternal(state: VimState, token: string, replaying: boolean): FeedResult {
  if (state.mode === 'insert') {
    if (token === '<Esc>' || token === '<C-[>') {
      const { state: next, effects } = leaveInsert(state, replaying);
      return { state: next, effects, handled: true };
    }
    return { state, effects: [], handled: false };
  }
  const pending = [...state.pending, token];
  const visual = state.mode !== 'normal';
  const parsed = visual ? parseVisual(pending) : parseNormal(pending);
  if (parsed === 'incomplete') return { state: { ...state, pending }, effects: [], handled: true };
  if (parsed === 'invalid') {
    const cleared = { ...state, pending: [] };
    if (pending.length === 1 && passesThrough(token))
      return { state: cleared, effects: [], handled: false, rejected: pending };
    return { state: cleared, effects: [], handled: true, rejected: pending };
  }
  return execute(new Exec({ ...state, pending: [] }, parsed, pending, replaying, feedInternal));
}

/** Runs a parsed command in the mode it was typed in. */
function execute(x: Exec): FeedResult {
  const cmd: Parsed = x.cmd;
  if (x.startMode === 'normal') {
    if (cmd.kind === 'motion') x.moveNormal(cmd.motion, cmd.count, cmd.countGiven);
    else if (cmd.kind === 'operator')
      operator(x, cmd.op, cmd.target, cmd.count, cmd.countGiven, cmd.register);
    else if (cmd.kind === 'command')
      command(x, cmd.key, cmd.count, cmd.countGiven, cmd.arg, cmd.register);
  } else {
    if (cmd.kind === 'motion') moveVisual(x, cmd.motion, cmd.count, cmd.countGiven);
    else if (cmd.kind === 'object') selectObject(x, cmd.around, cmd.key, cmd.count);
    else if (cmd.kind === 'command') visualCommand(x, cmd.key, cmd.count, cmd.arg, cmd.register);
  }
  if (x.s.mode !== x.startMode) x.effects.push({ type: 'mode', mode: x.s.mode });
  return { state: x.s, effects: x.effects, handled: true };
}

/** "NORMAL", "INSERT", "VISUAL", "V-LINE". */
export function modeLabel(mode: Mode): string {
  return mode === 'visual-line' ? 'V-LINE' : mode.toUpperCase();
}
