/**
 * Key parsing: turns the pending key buffer into a command, or reports it as
 * incomplete ("d2") or invalid. Pure; knows nothing about text.
 */

export type MotionSpec = { key: string; arg?: string };

export type Target =
  | { kind: 'motion'; motion: MotionSpec }
  | { kind: 'object'; around: 'i' | 'a'; key: string }
  | { kind: 'line' };

export type Parsed =
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

export type ParseResult = Parsed | 'incomplete' | 'invalid';

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

export function parseNormal(t: readonly string[]): ParseResult {
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

export function parseVisual(t: readonly string[]): ParseResult {
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

/** Named keys and chords the engine doesn't use keep their native/app meaning (Tab, Ctrl+K…). */
export function passesThrough(token: string): boolean {
  if (!token.startsWith('<') || token.length < 3) return false;
  return !['<Esc>', '<CR>', '<BS>', '<Del>', '<C-v>', '<C-x>'].includes(token);
}
