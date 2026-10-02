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
 */
import {
  findInLine,
  simpleMotion,
  textObject,
  type FindKind,
  type MotionKind,
  type MotionResult,
  type Range,
} from './motions';
import { TextModel } from './text';

export type Mode = 'normal' | 'insert' | 'visual' | 'visual-line';

export interface Register {
  text: string;
  linewise: boolean;
}

interface Snapshot {
  text: string;
  cursor: number;
}

/** The last change, for "." — the keys that made it and any text typed in Insert mode. */
export interface Change {
  keys: readonly string[];
  insert?: string;
}

interface InsertSession {
  /** State before the command that entered Insert mode (one undo step for both). */
  base: Snapshot;
  /** Text when Insert mode began, to work out what was typed. */
  entryText: string;
  /** Command keys for "." (null: not repeatable, e.g. entered by the host). */
  keys: readonly string[] | null;
  /** i/a/I/A with a count insert the typed text count times. */
  repeat: number;
}

export interface VimState {
  readonly text: string;
  /** UTF-16 offset of the cursor (Normal: the character under the block). */
  readonly cursor: number;
  /** Visual-mode anchor (UTF-16 offset). */
  readonly anchor: number;
  readonly mode: Mode;
  /** Keys of the command being typed ("d2", "f"). */
  readonly pending: readonly string[];
  readonly register: Register;
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  readonly lastChange: Change | null;
  readonly lastFind: { kind: FindKind; char: string } | null;
  /** Column j/k aim for. */
  readonly goal: number | null;
  readonly insert: InsertSession | null;
}

export type VimEffect =
  /** Normal-mode Enter: send the message. */
  | { type: 'submit' }
  /** Normal-mode Escape with nothing pending: the host's own Escape (cancel reply, mark read…). */
  | { type: 'escape' }
  /** "+y / "*y (and deletes into those registers): copy to the system clipboard. */
  | { type: 'clipboard'; text: string }
  | { type: 'mode'; mode: Mode };

export interface FeedResult {
  state: VimState;
  effects: VimEffect[];
  /** False: let the key do its native thing (Insert-mode typing, Tab, unknown chords). */
  handled: boolean;
  /** Keys that formed no engine command; the host may try them as app bindings ("gt"). */
  rejected?: readonly string[];
}

const UNDO_LIMIT = 200;

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

export interface FieldState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

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

/** Enters Insert mode from outside (the host focusing the composer with "i"/"a"/"A"/"I"). */
export function enterInsert(
  state: VimState,
  where: 'cursor' | 'after' | 'end' | 'start' = 'cursor',
): VimState {
  const m = new TextModel(state.text);
  const i = m.indexAt(state.cursor);
  let at = state.cursor;
  if (where === 'end') at = state.text.length;
  else if (where === 'start') at = 0;
  else if (where === 'after' && state.mode !== 'insert')
    at = m.offset(Math.min(m.lineEnd(m.lineOf(i)), i + 1));
  if (state.mode === 'insert') return { ...state, cursor: at };
  return startInsert({ ...state, pending: [] }, at, null, 1, snapshot(state));
}

export function enterNormal(state: VimState): VimState {
  if (state.mode === 'normal') return state;
  if (state.mode === 'insert') return leaveInsert(state, false).state;
  return toNormal(
    state,
    new TextModel(state.text),
    new TextModel(state.text).indexAt(state.cursor),
  );
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
  const ex = new Exec({ ...state, pending: [] }, parsed, pending, replaying);
  return ex.run();
}

/** Named keys and chords the engine doesn't use keep their native/app meaning (Tab, Ctrl+K…). */
function passesThrough(token: string): boolean {
  if (!token.startsWith('<') || token.length < 3) return false;
  return !['<Esc>', '<CR>', '<BS>', '<Del>', '<C-v>', '<C-x>'].includes(token);
}

// ─── Parsing ────────────────────────────────────────────────────────────

type MotionSpec = { key: string; arg?: string };

type Target =
  | { kind: 'motion'; motion: MotionSpec }
  | { kind: 'object'; around: 'i' | 'a'; key: string }
  | { kind: 'line' };

type Parsed =
  | {
      kind: 'motion';
      count: number;
      countGiven: boolean;
      motion: MotionSpec;
      register: string | null;
    }
  | {
      kind: 'operator';
      op: string;
      count: number;
      countGiven: boolean;
      target: Target;
      register: string | null;
    }
  | {
      kind: 'command';
      key: string;
      count: number;
      countGiven: boolean;
      arg?: string;
      register: string | null;
    }
  | { kind: 'object'; around: 'i' | 'a'; key: string; count: number };

type ParseResult = Parsed | 'incomplete' | 'invalid';

const OPERATORS = new Set(['d', 'c', 'y', '>', '<']);
const SINGLE_MOTIONS = new Set([
  'h',
  'j',
  'k',
  'l',
  'w',
  'W',
  'b',
  'B',
  'e',
  'E',
  '0',
  '^',
  '$',
  'G',
  '%',
  ';',
  ',',
  '<Left>',
  '<Right>',
  '<Up>',
  '<Down>',
  '<Home>',
  '<End>',
  '<BS>',
]);
const OBJECT_KEYS = new Set([
  'w',
  'W',
  '"',
  "'",
  '`',
  '(',
  ')',
  'b',
  '[',
  ']',
  '{',
  '}',
  'B',
  '<',
  '>',
]);
const NORMAL_COMMANDS = new Set([
  'x',
  'X',
  's',
  'S',
  '~',
  'J',
  'p',
  'P',
  'o',
  'O',
  'i',
  'a',
  'I',
  'A',
  'u',
  '<C-r>',
  '.',
  'D',
  'C',
  'Y',
  'v',
  'V',
  '<CR>',
  '<Esc>',
  '<C-[>',
  '<Del>',
  '<C-v>',
  '<C-x>',
]);
const VISUAL_COMMANDS = new Set([
  'd',
  'x',
  '<Del>',
  'X',
  'D',
  'c',
  's',
  'C',
  'S',
  'R',
  'y',
  'Y',
  '>',
  '<',
  '~',
  'u',
  'U',
  'J',
  'p',
  'P',
  'o',
  'O',
  'v',
  'V',
  '<Esc>',
  '<C-[>',
  '<C-v>',
  '<C-x>',
  '<CR>',
]);

const isPrintableArg = (t: string | undefined): t is string =>
  t !== undefined && (!t.startsWith('<') || t.length === 1);

function readCount(
  t: readonly string[],
  i: number,
): { count: number; given: boolean; next: number } {
  let s = '';
  while (i < t.length && /^[0-9]$/u.test(t[i] ?? '') && !(s === '' && t[i] === '0')) {
    s += t[i] ?? '';
    i++;
  }
  return { count: s === '' ? 1 : Math.min(9999, Number(s)), given: s !== '', next: i };
}

function parseMotionAt(
  t: readonly string[],
  i: number,
): { motion: MotionSpec; next: number } | 'incomplete' | 'invalid' {
  const key = t[i];
  if (key === undefined) return 'incomplete';
  if (SINGLE_MOTIONS.has(key)) return { motion: { key }, next: i + 1 };
  if (key === 'g') {
    const k2 = t[i + 1];
    if (k2 === undefined) return 'incomplete';
    return k2 === 'g' ? { motion: { key: 'gg' }, next: i + 2 } : 'invalid';
  }
  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    const arg = t[i + 1];
    if (arg === undefined) return 'incomplete';
    return isPrintableArg(arg) ? { motion: { key, arg }, next: i + 2 } : 'invalid';
  }
  return 'invalid';
}

function exact<T extends { next: number }>(r: T, t: readonly string[]): T | 'invalid' {
  return r.next === t.length ? r : 'invalid';
}

function parseNormal(t: readonly string[]): ParseResult {
  let i = 0;
  let register: string | null = null;
  if (t[0] === '"') {
    if (t.length < 2) return 'incomplete';
    register = t[1] ?? null;
    i = 2;
  }
  const c1 = readCount(t, i);
  i = c1.next;
  const key = t[i];
  if (key === undefined) return 'incomplete';
  if (OPERATORS.has(key)) {
    const c2 = readCount(t, i + 1);
    const count = c1.count * c2.count;
    const countGiven = c1.given || c2.given;
    const j = c2.next;
    const k2 = t[j];
    if (k2 === undefined) return 'incomplete';
    const base = { kind: 'operator' as const, op: key, count, countGiven, register };
    if (k2 === key) return j + 1 === t.length ? { ...base, target: { kind: 'line' } } : 'invalid';
    if (k2 === 'i' || k2 === 'a') {
      const k3 = t[j + 1];
      if (k3 === undefined) return 'incomplete';
      if (!OBJECT_KEYS.has(k3) || j + 2 !== t.length) return 'invalid';
      return { ...base, target: { kind: 'object', around: k2, key: k3 } };
    }
    const m = parseMotionAt(t, j);
    if (typeof m === 'string') return m;
    const ok = exact(m, t);
    if (ok === 'invalid') return ok;
    return { ...base, target: { kind: 'motion', motion: ok.motion } };
  }
  if (key === 'r') {
    const arg = t[i + 1];
    if (arg === undefined) return 'incomplete';
    if (!(isPrintableArg(arg) || arg === '<CR>') || i + 2 !== t.length) return 'invalid';
    return { kind: 'command', key, count: c1.count, countGiven: c1.given, arg, register };
  }
  if (NORMAL_COMMANDS.has(key))
    return i + 1 === t.length
      ? { kind: 'command', key, count: c1.count, countGiven: c1.given, register }
      : 'invalid';
  const m = parseMotionAt(t, i);
  if (typeof m === 'string') return m;
  const ok = exact(m, t);
  if (ok === 'invalid') return ok;
  return { kind: 'motion', count: c1.count, countGiven: c1.given, motion: ok.motion, register };
}

function parseVisual(t: readonly string[]): ParseResult {
  let i = 0;
  let register: string | null = null;
  if (t[0] === '"') {
    if (t.length < 2) return 'incomplete';
    register = t[1] ?? null;
    i = 2;
  }
  const c = readCount(t, i);
  i = c.next;
  const key = t[i];
  if (key === undefined) return 'incomplete';
  if (key === 'i' || key === 'a') {
    const k2 = t[i + 1];
    if (k2 === undefined) return 'incomplete';
    if (!OBJECT_KEYS.has(k2) || i + 2 !== t.length) return 'invalid';
    return { kind: 'object', around: key, key: k2, count: c.count };
  }
  if (key === 'r') {
    const arg = t[i + 1];
    if (arg === undefined) return 'incomplete';
    if (!isPrintableArg(arg) || i + 2 !== t.length) return 'invalid';
    return { kind: 'command', key, count: c.count, countGiven: c.given, arg, register };
  }
  if (VISUAL_COMMANDS.has(key))
    return i + 1 === t.length
      ? { kind: 'command', key, count: c.count, countGiven: c.given, register }
      : 'invalid';
  const m = parseMotionAt(t, i);
  if (typeof m === 'string') return m;
  const ok = exact(m, t);
  if (ok === 'invalid') return ok;
  return { kind: 'motion', count: c.count, countGiven: c.given, motion: ok.motion, register };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function snapshot(s: VimState): Snapshot {
  return { text: s.text, cursor: s.cursor };
}

/** The nearest offset a Normal-mode cursor may rest on. */
function normalOffset(text: string, offset: number): number {
  const m = new TextModel(text);
  return m.offset(clampNormal(m, m.indexAt(offset)));
}

function clampNormal(m: TextModel, i: number): number {
  const line = m.lineOf(Math.max(0, Math.min(m.n, i)));
  return Math.max(m.lineStart(line), Math.min(i, m.lineLast(line)));
}

function visualRange(m: TextModel, s: VimState): Range {
  const a = m.indexAt(s.anchor);
  const c = m.indexAt(s.cursor);
  if (s.mode === 'visual-line') {
    const l1 = m.lineOf(Math.min(a, c));
    const l2 = m.lineOf(Math.max(a, c));
    return { from: m.lineStart(l1), to: m.lineEnd(l2) };
  }
  return { from: Math.min(a, c), to: Math.min(m.n, Math.max(a, c) + 1) };
}

function startInsert(
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

function pushUndo(s: VimState, snap: Snapshot): Pick<VimState, 'undo' | 'redo'> {
  return { undo: [...s.undo, snap].slice(-UNDO_LIMIT), redo: [] };
}

function leaveInsert(
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

function toNormal(s: VimState, m: TextModel, at: number): VimState {
  return { ...s, mode: 'normal', cursor: m.offset(clampNormal(m, at)), pending: [] };
}

// ─── Execution ──────────────────────────────────────────────────────────

class Exec {
  private s: VimState;
  private m: TextModel;
  private readonly effects: VimEffect[] = [];
  private readonly startMode: Mode;

  constructor(
    state: VimState,
    private readonly cmd: Parsed,
    private readonly keys: readonly string[],
    private readonly replaying: boolean,
  ) {
    this.s = state;
    this.m = new TextModel(state.text);
    this.startMode = state.mode;
  }

  run(): FeedResult {
    const { cmd } = this;
    if (this.startMode === 'normal') {
      if (cmd.kind === 'motion') this.moveNormal(cmd.motion, cmd.count, cmd.countGiven);
      else if (cmd.kind === 'operator')
        this.operator(cmd.op, cmd.target, cmd.count, cmd.countGiven, cmd.register);
      else if (cmd.kind === 'command')
        this.command(cmd.key, cmd.count, cmd.countGiven, cmd.arg, cmd.register);
    } else {
      if (cmd.kind === 'motion') this.moveVisual(cmd.motion, cmd.count, cmd.countGiven);
      else if (cmd.kind === 'object') this.selectObject(cmd.around, cmd.key, cmd.count);
      else if (cmd.kind === 'command')
        this.visualCommand(cmd.key, cmd.count, cmd.arg, cmd.register);
    }
    if (this.s.mode !== this.startMode) this.effects.push({ type: 'mode', mode: this.s.mode });
    return { state: this.s, effects: this.effects, handled: true };
  }

  // ── state helpers

  private get cur(): number {
    return this.m.indexAt(this.s.cursor);
  }

  private set(next: Partial<VimState>): void {
    this.s = { ...this.s, ...next };
    if (next.text !== undefined) this.m = new TextModel(this.s.text);
  }

  private setCursor(i: number, keepGoal = false): void {
    this.set({ cursor: this.m.offset(i), ...(keepGoal ? {} : { goal: null }) });
  }

  /** Replaces grapheme range [from, to) with `insert`; cursor goes to grapheme `cursorAt` of the new text. */
  private replace(from: number, to: number, insert: string): void {
    const a = this.m.offset(from);
    const b = this.m.offset(to);
    this.set({ text: this.s.text.slice(0, a) + insert + this.s.text.slice(b) });
  }

  private yank(text: string, linewise: boolean, register: string | null): void {
    this.set({ register: { text, linewise } });
    if (register === '+' || register === '*') this.effects.push({ type: 'clipboard', text });
  }

  /** Only Normal-mode commands are repeatable ("." replays keys in Normal mode). */
  private get repeatKeys(): readonly string[] | null {
    return this.startMode === 'normal' && !this.replaying ? this.keys : null;
  }

  private recordChange(): void {
    const keys = this.repeatKeys;
    if (keys) this.set({ lastChange: { keys } });
  }

  /** Runs a text change as one undo step. */
  private change(fn: () => void, repeatable = true): void {
    const before = snapshot(this.s);
    fn();
    if (this.s.text !== before.text) {
      this.set(pushUndo(this.s, before));
      if (repeatable) this.recordChange();
    }
  }

  private insertAt(i: number, base: Snapshot, repeat = 1): void {
    this.s = startInsert(this.s, this.m.offset(i), this.repeatKeys, repeat, base);
  }

  // ── motions

  private motion(
    spec: MotionSpec,
    count: number,
    countGiven: boolean,
    operator: boolean,
  ): MotionResult | null {
    const { m } = this;
    const from = this.cur;
    if (spec.key === ';' || spec.key === ',') {
      const last = this.s.lastFind;
      if (!last) return null;
      const reverse: Record<FindKind, FindKind> = { f: 'F', F: 'f', t: 'T', T: 't' };
      const kind = spec.key === ';' ? last.kind : reverse[last.kind];
      const to = findInLine(m, from, kind, last.char, count, true);
      if (to === null) return null;
      return { to, kind: kind === 'f' || kind === 't' ? 'inclusive' : 'exclusive', goal: null };
    }
    if (spec.arg !== undefined) {
      const kind = spec.key as FindKind;
      this.set({ lastFind: { kind, char: spec.arg } });
      const to = findInLine(m, from, kind, spec.arg, count);
      if (to === null) return null;
      return { to, kind: kind === 'f' || kind === 't' ? 'inclusive' : 'exclusive', goal: null };
    }
    const r = simpleMotion(m, from, spec.key, { count, countGiven, operator, goal: this.s.goal });
    return r === 'fail' || r === null ? null : r;
  }

  private moveNormal(spec: MotionSpec, count: number, countGiven: boolean): void {
    const r = this.motion(spec, count, countGiven, false);
    if (!r) return;
    this.set({
      cursor: this.m.offset(clampNormal(this.m, r.to)),
      goal: r.goal === undefined ? this.s.goal : r.goal,
    });
  }

  private moveVisual(spec: MotionSpec, count: number, countGiven: boolean): void {
    const r = this.motion(spec, count, countGiven, false);
    if (!r) return;
    this.set({
      cursor: this.m.offset(Math.min(r.to, Math.max(0, this.m.n - 1))),
      goal: r.goal === undefined ? this.s.goal : r.goal,
    });
  }

  // ── operators

  private operator(
    op: string,
    target: Target,
    count: number,
    countGiven: boolean,
    register: string | null,
  ): void {
    const { m } = this;
    const from = this.cur;
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
      const r = this.motion(spec, count, countGiven, true);
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
    this.applyOperator(op, range, kind === 'linewise', register);
  }

  /** d / c / y / > / < over a charwise range or whole lines. */
  private applyOperator(
    op: string,
    range: Range,
    linewise: boolean,
    register: string | null,
  ): void {
    const { m } = this;
    if (linewise) {
      const l1 = m.lineOf(range.from);
      const l2 = m.lineOf(range.to);
      const text = `${m.slice(m.lineStart(l1), m.lineEnd(l2))}\n`;
      if (op === 'y') {
        this.yank(text, true, register);
        if (l1 < m.lineOf(this.cur)) this.setCursor(m.lineStart(l1));
        return;
      }
      if (op === '>' || op === '<') {
        this.change(() => {
          this.indent(l1, l2, op === '>');
          this.setCursor(this.m.firstNonBlank(l1));
        });
        return;
      }
      this.yank(text, true, register);
      if (op === 'd') {
        this.change(() => {
          this.deleteLines(l1, l2);
          const line = Math.min(l1, this.m.lineCount - 1);
          this.setCursor(this.m.firstNonBlank(line));
        });
      } else {
        const base = snapshot(this.s);
        this.replace(m.lineStart(l1), m.lineEnd(l2), '');
        this.insertAt(this.m.lineStart(l1), base);
      }
      return;
    }
    const text = m.slice(range.from, range.to);
    if (op === '>' || op === '<') {
      const l1 = m.lineOf(range.from);
      const l2 = m.lineOf(Math.max(range.from, range.to - 1));
      this.change(() => {
        this.indent(l1, l2, op === '>');
        this.setCursor(this.m.firstNonBlank(l1));
      });
      return;
    }
    this.yank(text, false, register);
    if (op === 'y') {
      this.setCursor(clampNormal(m, range.from));
      return;
    }
    if (op === 'd') {
      this.change(() => {
        this.replace(range.from, range.to, '');
        this.setCursor(clampNormal(this.m, range.from));
      });
    } else {
      const base = snapshot(this.s);
      this.replace(range.from, range.to, '');
      this.insertAt(range.from, base);
    }
  }

  private deleteLines(l1: number, l2: number): void {
    const { m } = this;
    const hasNext = l2 + 1 < m.lineCount;
    if (hasNext) this.replace(m.lineStart(l1), m.lineStart(l2 + 1), '');
    else if (l1 > 0) this.replace(m.lineEnd(l1 - 1), m.n, '');
    else this.replace(0, m.n, '');
  }

  private indent(l1: number, l2: number, more: boolean): void {
    const lines = this.s.text.split('\n');
    for (let l = l1; l <= l2; l++) {
      const line = lines[l] ?? '';
      if (more) lines[l] = line === '' ? line : `  ${line}`;
      else lines[l] = line.replace(/^(\t| {1,2})/u, '');
    }
    this.set({ text: lines.join('\n') });
  }

  // ── Normal-mode commands

  private command(
    key: string,
    count: number,
    countGiven: boolean,
    arg: string | undefined,
    register: string | null,
  ): void {
    const { m } = this;
    const from = this.cur;
    const line = m.lineOf(from);
    switch (key) {
      case '<Esc>':
      case '<C-[>':
        this.effects.push({ type: 'escape' });
        return;
      case '<CR>':
        this.effects.push({ type: 'submit' });
        return;
      case '<C-v>':
      case '<C-x>':
        // Swallowed: the block cursor is a selection, and paste/cut would replace it.
        return;
      case 'x':
      case '<Del>': {
        const end = Math.min(m.lineEnd(line), from + count);
        if (end <= from) return;
        this.yank(m.slice(from, end), false, register);
        this.change(() => {
          this.replace(from, end, '');
          this.setCursor(clampNormal(this.m, from));
        });
        return;
      }
      case 'X': {
        const start = Math.max(m.lineStart(line), from - count);
        if (start >= from) return;
        this.yank(m.slice(start, from), false, register);
        this.change(() => {
          this.replace(start, from, '');
          this.setCursor(clampNormal(this.m, start));
        });
        return;
      }
      case 's': {
        const end = Math.min(m.lineEnd(line), from + count);
        const base = snapshot(this.s);
        if (end > from) this.yank(m.slice(from, end), false, register);
        this.replace(from, end, '');
        this.insertAt(from, base);
        return;
      }
      case 'S':
        this.operator('c', { kind: 'line' }, count, countGiven, register);
        return;
      case 'C':
        this.operator('c', { kind: 'motion', motion: { key: '$' } }, count, countGiven, register);
        return;
      case 'D':
        this.operator('d', { kind: 'motion', motion: { key: '$' } }, count, countGiven, register);
        return;
      case 'Y':
        this.operator('y', { kind: 'line' }, count, countGiven, register);
        return;
      case 'r': {
        const end = from + count;
        if (end > m.lineEnd(line) || arg === undefined) return;
        const ch = arg === '<CR>' ? '\n' : arg;
        this.change(() => {
          this.replace(from, end, ch === '\n' ? '\n' : ch.repeat(count));
          this.setCursor(ch === '\n' ? this.m.lineStart(line + 1) : from + count - 1);
        });
        return;
      }
      case '~': {
        const end = Math.min(m.lineEnd(line), from + count);
        if (end <= from) return;
        this.change(() => {
          this.replace(from, end, toggleCase(m.slice(from, end)));
          this.setCursor(clampNormal(this.m, end));
        });
        return;
      }
      case 'J':
        this.change(() => {
          this.join(line, Math.max(2, count));
        });
        return;
      case 'p':
      case 'P':
        this.put(key === 'p', count);
        return;
      case 'o':
      case 'O': {
        const base = snapshot(this.s);
        if (key === 'o') {
          const end = m.lineEnd(line);
          this.replace(end, end, '\n');
          this.insertAt(end + 1, base);
        } else {
          const start = m.lineStart(line);
          this.replace(start, start, '\n');
          this.insertAt(start, base);
        }
        return;
      }
      case 'i':
        this.insertAt(from, snapshot(this.s), count);
        return;
      case 'a':
        this.insertAt(Math.min(m.lineEnd(line), from + 1), snapshot(this.s), count);
        return;
      case 'I':
        this.insertAt(m.firstNonBlank(line), snapshot(this.s), count);
        return;
      case 'A':
        this.insertAt(m.lineEnd(line), snapshot(this.s), count);
        return;
      case 'u':
        for (let k = 0; k < count; k++) this.undo();
        return;
      case '<C-r>':
        for (let k = 0; k < count; k++) this.redo();
        return;
      case '.':
        this.repeat(countGiven ? count : null);
        return;
      case 'v':
      case 'V':
        this.set({ mode: key === 'v' ? 'visual' : 'visual-line', anchor: this.s.cursor });
        return;
    }
  }

  private join(line: number, lines: number): void {
    let last = Math.min(this.m.lineCount - 1, line + lines - 1);
    if (last === line) return;
    let cursor = 0;
    for (; last > line; last--) {
      const { m } = this;
      const nl = m.lineEnd(line);
      let next = nl + 1;
      while (next < m.lineEnd(line + 1) && /^[ \t]$/u.test(m.g[next] ?? '')) next++;
      let left = nl;
      while (left > m.lineStart(line) && /^[ \t]$/u.test(m.g[left - 1] ?? '')) left--;
      const nextChar = m.g[next];
      const sep =
        left === m.lineStart(line) || next === m.lineEnd(line + 1) || nextChar === ')' ? '' : ' ';
      this.replace(left, next, sep);
      cursor = left;
    }
    this.setCursor(clampNormal(this.m, cursor));
  }

  private put(after: boolean, count: number): void {
    const reg = this.s.register;
    if (reg.text === '') return;
    const { m } = this;
    const from = this.cur;
    const line = m.lineOf(from);
    this.change(() => {
      if (reg.linewise) {
        const block = reg.text.repeat(count);
        if (after) {
          const end = m.lineEnd(line);
          if (end === m.n) {
            // Last line has no newline to insert after.
            this.replace(end, end, `\n${block.slice(0, -1)}`);
          } else this.replace(end + 1, end + 1, block);
          this.setCursor(this.m.firstNonBlank(line + 1));
        } else {
          this.replace(m.lineStart(line), m.lineStart(line), block);
          this.setCursor(this.m.firstNonBlank(line));
        }
        return;
      }
      const text = reg.text.repeat(count);
      const at = after && m.n > 0 && from < m.lineEnd(line) ? from + 1 : from;
      this.replace(at, at, text);
      const inserted = new TextModel(text).n;
      this.setCursor(clampNormal(this.m, at + inserted - 1));
    });
  }

  private undo(): void {
    const prev = this.s.undo.at(-1);
    if (!prev) return;
    this.set({
      text: prev.text,
      undo: this.s.undo.slice(0, -1),
      redo: [...this.s.redo, snapshot(this.s)],
    });
    this.setCursor(clampNormal(this.m, this.m.indexAt(prev.cursor)));
  }

  private redo(): void {
    const next = this.s.redo.at(-1);
    if (!next) return;
    const current = snapshot(this.s);
    this.set({ text: next.text, redo: this.s.redo.slice(0, -1), undo: [...this.s.undo, current] });
    this.setCursor(clampNormal(this.m, this.m.indexAt(Math.min(current.cursor, next.text.length))));
  }

  /** "." replays the last change's keys, then its typed text; a count replaces the original. */
  private repeat(count: number | null): void {
    const last = this.s.lastChange;
    if (!last) return;
    let keys = [...last.keys];
    if (count !== null) {
      const regLen = keys[0] === '"' ? 2 : 0;
      let j = regLen;
      while (
        j < keys.length &&
        /^[0-9]$/u.test(keys[j] ?? '') &&
        !(j === regLen && keys[j] === '0')
      )
        j++;
      keys = [...keys.slice(0, regLen), ...String(count).split(''), ...keys.slice(j)];
    }
    let state: VimState = { ...this.s, pending: [] };
    for (const k of keys) {
      const r = feedInternal(state, k, true);
      state = r.state;
      this.effects.push(...r.effects.filter((e) => e.type === 'clipboard'));
    }
    if (state.mode === 'insert') {
      const typed = last.insert ?? '';
      const text = state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor);
      state = leaveInsert({ ...state, text, cursor: state.cursor + typed.length }, true).state;
    }
    this.s = { ...state, lastChange: last };
    this.m = new TextModel(this.s.text);
  }

  // ── Visual mode

  private selectObject(around: 'i' | 'a', key: string, count: number): void {
    const r = textObject(this.m, this.cur, around, key, count);
    if (!r || r.to <= r.from) return;
    this.set({ mode: 'visual', anchor: this.m.offset(r.from), cursor: this.m.offset(r.to - 1) });
  }

  private visualCommand(
    key: string,
    count: number,
    arg: string | undefined,
    register: string | null,
  ): void {
    const { m } = this;
    const lineMode = this.s.mode === 'visual-line';
    const range = visualRange(m, this.s);
    const exitTo = (i: number) => {
      this.s = toNormal(this.s, this.m, i);
    };
    switch (key) {
      case '<Esc>':
      case '<C-[>':
      case '<CR>':
        exitTo(this.cur);
        return;
      case '<C-v>':
      case '<C-x>':
        return;
      case 'v':
      case 'V': {
        const target = key === 'v' ? 'visual' : 'visual-line';
        if (this.s.mode === target) exitTo(this.cur);
        else this.set({ mode: target });
        return;
      }
      case 'o':
      case 'O':
        this.set({ anchor: this.s.cursor, cursor: this.s.anchor });
        return;
      case 'y':
      case 'Y': {
        const linewise = lineMode || key === 'Y';
        const r = key === 'Y' ? lineRange(m, range) : range;
        this.s = { ...this.s, mode: 'normal' };
        this.applyOperator('y', r, linewise, register);
        this.setCursor(
          clampNormal(this.m, linewise ? this.m.lineStart(m.lineOf(range.from)) : range.from),
        );
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
        this.s = { ...this.s, mode: 'normal', cursor: m.offset(range.from) };
        this.applyOperator(op, linewise ? lineRange(m, range) : range, linewise, register);
        return;
      }
      case '>':
      case '<': {
        const l1 = m.lineOf(range.from);
        const l2 = m.lineOf(Math.max(range.from, range.to - 1));
        this.s = { ...this.s, mode: 'normal' };
        this.change(() => {
          for (let k = 0; k < count; k++) this.indent(l1, l2, key === '>');
          this.setCursor(this.m.firstNonBlank(l1));
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
        this.s = { ...this.s, mode: 'normal' };
        this.change(() => {
          this.replace(range.from, range.to, fn(m.slice(range.from, range.to)));
          this.setCursor(clampNormal(this.m, range.from));
        }, false);
        return;
      }
      case 'r': {
        if (arg === undefined) return;
        this.s = { ...this.s, mode: 'normal' };
        const replaced = m.g
          .slice(range.from, range.to)
          .map((g) => (g === '\n' ? g : arg))
          .join('');
        this.change(() => {
          this.replace(range.from, range.to, replaced);
          this.setCursor(clampNormal(this.m, range.from));
        }, false);
        return;
      }
      case 'J': {
        const l1 = m.lineOf(range.from);
        const l2 = m.lineOf(Math.max(range.from, range.to - 1));
        this.s = { ...this.s, mode: 'normal' };
        this.change(() => {
          this.join(l1, Math.max(2, l2 - l1 + 1));
        }, false);
        return;
      }
      case 'p':
      case 'P': {
        const reg = this.s.register;
        const r = lineMode ? lineRange(m, range) : range;
        const removed = m.slice(r.from, r.to);
        this.s = { ...this.s, mode: 'normal' };
        this.change(() => {
          const insert =
            reg.linewise && !lineMode
              ? `\n${reg.text}`
              : !reg.linewise && lineMode
                ? reg.text
                : reg.linewise
                  ? reg.text.slice(0, -1)
                  : reg.text;
          this.replace(r.from, r.to, insert.repeat(count));
          this.setCursor(clampNormal(this.m, r.from));
        }, false);
        if (key === 'p') this.yank(lineMode ? `${removed}\n` : removed, lineMode, register);
        return;
      }
    }
  }
}

function lineRange(m: TextModel, r: Range): Range {
  const l1 = m.lineOf(r.from);
  const l2 = m.lineOf(Math.max(r.from, r.to - 1));
  return { from: m.lineStart(l1), to: m.lineEnd(l2) };
}

function toggleCase(text: string): string {
  return Array.from(text, (c) => {
    const lower = c.toLowerCase();
    return c === lower ? c.toUpperCase() : lower;
  }).join('');
}

/** "NORMAL", "INSERT", "VISUAL", "V-LINE". */
export function modeLabel(mode: Mode): string {
  return mode === 'visual-line' ? 'V-LINE' : mode.toUpperCase();
}
