/**
 * Motions and text objects over a TextModel, in grapheme indices. Each
 * motion reports how an operator should treat its range: exclusive (the
 * default), inclusive (e, f, t, $, %) or linewise (j, k, gg, G).
 */
import { charClass, type TextModel } from './text';

export type MotionKind = 'exclusive' | 'inclusive' | 'linewise';

export interface MotionResult {
  to: number;
  kind: MotionKind;
  /** Column j/k should aim for afterwards (null = keep the current goal). */
  goal?: number | null;
}

export type FindKind = 'f' | 'F' | 't' | 'T';

export interface MotionEnv {
  count: number;
  /** True when an operator will consume the range (l may then reach the line end). */
  operator: boolean;
  /** Whether a count was typed (G and gg go to that line). */
  countGiven: boolean;
  /** Column j/k aim for (Infinity after $). */
  goal: number | null;
}

// ─── Words ──────────────────────────────────────────────────────────────

export function nextWordStart(m: TextModel, from: number, big: boolean): number {
  let i = from;
  const n = m.n;
  if (i >= n) return n;
  const c = charClass(m.g[i], big);
  if (c !== 0) while (i < n && charClass(m.g[i], big) === c) i++;
  while (i < n && charClass(m.g[i], big) === 0) {
    if (m.g[i] === '\n') {
      i++;
      // An empty line counts as a word.
      if (i < n && m.g[i] === '\n') return i;
      continue;
    }
    i++;
  }
  return i;
}

export function wordEnd(m: TextModel, from: number, big: boolean): number {
  const n = m.n;
  let i = from + 1;
  while (i < n && charClass(m.g[i], big) === 0) i++;
  if (i >= n) return Math.max(0, n - 1);
  const c = charClass(m.g[i], big);
  while (i + 1 < n && charClass(m.g[i + 1], big) === c) i++;
  return i;
}

export function prevWordStart(m: TextModel, from: number, big: boolean): number {
  let i = from - 1;
  if (i <= 0) return 0;
  while (i > 0 && charClass(m.g[i], big) === 0) {
    if (m.g[i] === '\n' && m.g[i - 1] === '\n') return i;
    i--;
  }
  const c = charClass(m.g[i], big);
  if (c === 0) return i;
  while (i > 0 && charClass(m.g[i - 1], big) === c) i--;
  return i;
}

// ─── Finding characters ─────────────────────────────────────────────────

/** f/F/t/T within the cursor's line; null if not found `count` times. */
export function findInLine(
  m: TextModel,
  from: number,
  kind: FindKind,
  char: string,
  count: number,
  repeat = false,
): number | null {
  const line = m.lineOf(from);
  const start = m.lineStart(line);
  const end = m.lineEnd(line);
  const forward = kind === 'f' || kind === 't';
  // Repeating t/T must not stick on the character right next to the cursor.
  const skip = repeat && (kind === 't' || kind === 'T') ? 1 : 0;
  let i = from;
  let found = -1;
  for (let k = 0; k < count; k++) {
    let j = forward ? i + 1 + (k === 0 ? skip : 0) : i - 1 - (k === 0 ? skip : 0);
    while (forward ? j < end : j >= start) {
      if (m.g[j] === char) break;
      j += forward ? 1 : -1;
    }
    if (forward ? j >= end : j < start) return null;
    found = j;
    i = j;
  }
  if (kind === 't') return found - 1;
  if (kind === 'T') return found + 1;
  return found;
}

const PAIRS: Record<string, [open: string, close: string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
};

/** % — the bracket under (or after, on the line) the cursor jumps to its partner. */
export function matchBracket(m: TextModel, from: number): number | null {
  const end = m.lineEnd(m.lineOf(from));
  let i = from;
  while (i < end && !((m.g[i] ?? '') in PAIRS)) i++;
  const ch = m.g[i];
  if (ch === undefined || !(ch in PAIRS) || i >= end) return null;
  const [open, close] = PAIRS[ch] as [string, string];
  const forward = ch === open;
  let depth = 0;
  for (let j = i; forward ? j < m.n : j >= 0; j += forward ? 1 : -1) {
    if (m.g[j] === open) depth += forward ? 1 : -1;
    else if (m.g[j] === close) depth += forward ? -1 : 1;
    if (depth === 0) return j;
  }
  return null;
}

// ─── Simple motions ─────────────────────────────────────────────────────

/** A motion by key (single-token motions plus gg); null if the key isn't one. */
export function simpleMotion(
  m: TextModel,
  from: number,
  key: string,
  env: MotionEnv,
): MotionResult | null | 'fail' {
  const { count } = env;
  const line = m.lineOf(from);
  switch (key) {
    case 'h':
    case '<Left>':
    case '<BS>': {
      const start = m.lineStart(line);
      if (from <= start) return 'fail';
      return { to: Math.max(start, from - count), kind: 'exclusive', goal: null };
    }
    case 'l':
    case '<Right>': {
      const limit = env.operator ? m.lineEnd(line) : m.lineLast(line);
      if (from >= limit) return 'fail';
      return { to: Math.min(limit, from + count), kind: 'exclusive', goal: null };
    }
    case 'j':
    case '<Down>':
    case 'k':
    case '<Up>': {
      const down = key === 'j' || key === '<Down>';
      const target = down ? Math.min(m.lineCount - 1, line + count) : Math.max(0, line - count);
      if (target === line) return 'fail';
      const goal = env.goal ?? m.column(from);
      const col = Math.min(goal, m.lineLast(target) - m.lineStart(target));
      return { to: m.lineStart(target) + col, kind: 'linewise', goal };
    }
    case '0':
    case '<Home>':
      return { to: m.lineStart(line), kind: 'exclusive', goal: null };
    case '^':
      return { to: m.firstNonBlank(line), kind: 'exclusive', goal: null };
    case '$':
    case '<End>': {
      const target = Math.min(m.lineCount - 1, line + count - 1);
      return {
        to: env.operator
          ? Math.max(m.lineStart(target), m.lineEnd(target) - 1)
          : m.lineLast(target),
        kind: 'inclusive',
        goal: Number.POSITIVE_INFINITY,
      };
    }
    case 'w':
    case 'W':
    case 'b':
    case 'B': {
      const big = key === 'W' || key === 'B';
      let i = from;
      for (let k = 0; k < count; k++)
        i = key === 'w' || key === 'W' ? nextWordStart(m, i, big) : prevWordStart(m, i, big);
      if (i === from) return 'fail';
      return { to: i, kind: 'exclusive', goal: null };
    }
    case 'e':
    case 'E': {
      let i = from;
      for (let k = 0; k < count; k++) i = wordEnd(m, i, key === 'E');
      if (i === from) return 'fail';
      return { to: i, kind: 'inclusive', goal: null };
    }
    case 'G':
    case 'gg': {
      const target = env.countGiven
        ? Math.min(m.lineCount - 1, env.count - 1)
        : key === 'gg'
          ? 0
          : m.lineCount - 1;
      return { to: m.firstNonBlank(target), kind: 'linewise', goal: null };
    }
    case '%': {
      const to = matchBracket(m, from);
      return to === null ? 'fail' : { to, kind: 'inclusive', goal: null };
    }
    default:
      return null;
  }
}

// ─── Text objects ───────────────────────────────────────────────────────

export interface Range {
  from: number;
  to: number;
}

/** iw / aw / iW / aW, within the cursor's line. */
export function wordObject(m: TextModel, at: number, around: boolean, big: boolean): Range | null {
  const line = m.lineOf(at);
  const start = m.lineStart(line);
  const end = m.lineEnd(line);
  if (start === end) return null;
  const i = Math.min(at, end - 1);
  const cls = charClass(m.g[i], big);
  let from = i;
  let to = i + 1;
  while (from > start && charClass(m.g[from - 1], big) === cls) from--;
  while (to < end && charClass(m.g[to], big) === cls) to++;
  if (!around) return { from, to };
  if (cls === 0) {
    // On blanks: the blanks plus the following word.
    if (to < end) {
      const c = charClass(m.g[to], big);
      while (to < end && charClass(m.g[to], big) === c) to++;
    }
    return { from, to };
  }
  // On a word: trailing blanks, or leading ones if there are none after.
  let after = to;
  while (after < end && charClass(m.g[after], big) === 0) after++;
  if (after > to) return { from, to: after };
  let before = from;
  while (before > start && charClass(m.g[before - 1], big) === 0) before--;
  return { from: before, to };
}

/** i" a" i' a' i` a`: the quoted string containing (or after) the cursor on its line. */
export function quoteObject(
  m: TextModel,
  at: number,
  quote: string,
  around: boolean,
): Range | null {
  const line = m.lineOf(at);
  const start = m.lineStart(line);
  const end = m.lineEnd(line);
  const quotes: number[] = [];
  for (let i = start; i < end; i++) if (m.g[i] === quote && m.g[i - 1] !== '\\') quotes.push(i);
  let open: number | undefined;
  let close: number | undefined;
  const onQuote = quotes.indexOf(at);
  if (onQuote !== -1) {
    [open, close] = onQuote % 2 === 0 ? [at, quotes[onQuote + 1]] : [quotes[onQuote - 1], at];
  } else {
    // Off a quote: the nearest quotes around the cursor, else the first pair after it.
    const before = quotes.filter((q) => q < at).at(-1);
    const after = quotes.filter((q) => q > at);
    [open, close] =
      before !== undefined && after.length > 0 ? [before, after[0]] : [after[0], after[1]];
  }
  if (open === undefined || close === undefined) return null;
  if (!around) return { from: open + 1, to: close };
  let to = close + 1;
  let from = open;
  if (to < end && charClass(m.g[to]) === 0) while (to < end && charClass(m.g[to]) === 0) to++;
  else while (from > start && charClass(m.g[from - 1]) === 0) from--;
  return { from, to };
}

const BRACKET_ALIASES: Record<string, string> = {
  b: '(',
  '(': '(',
  ')': '(',
  '[': '[',
  ']': '[',
  B: '{',
  '{': '{',
  '}': '{',
  '<': '<',
  '>': '<',
};

/** i( a( ib i[ i{ iB i< …: the count-th enclosing bracket pair (may span lines). */
export function bracketObject(
  m: TextModel,
  at: number,
  key: string,
  around: boolean,
  count: number,
): Range | null {
  const open = BRACKET_ALIASES[key];
  if (!open) return null;
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open] as string;
  const scanBack = (from: number): number => {
    let depth = 0;
    for (let i = from; i >= 0; i--) {
      if (m.g[i] === close) depth++;
      else if (m.g[i] === open) {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  };
  // On an opening bracket that's the pair; on a closing one, its partner.
  let left = m.g[at] === open ? at : scanBack(at - 1);
  for (let k = 1; k < count && left >= 0; k++) left = scanBack(left - 1);
  if (left < 0) return null;
  let depth = 0;
  let right = -1;
  for (let j = left + 1; j < m.n; j++) {
    if (m.g[j] === open) depth++;
    else if (m.g[j] === close) {
      if (depth === 0) {
        right = j;
        break;
      }
      depth--;
    }
  }
  if (right < 0) return null;
  if (around) return { from: left, to: right + 1 };
  let innerFrom = left + 1;
  let innerTo = right;
  // A block whose brackets sit on their own lines: keep those line breaks.
  if (m.g[innerFrom] === '\n') innerFrom++;
  let k = innerTo - 1;
  while (k >= innerFrom && (m.g[k] === ' ' || m.g[k] === '\t')) k--;
  if (k >= innerFrom && m.g[k] === '\n') innerTo = k;
  return { from: innerFrom, to: Math.max(innerFrom, innerTo) };
}

export function textObject(
  m: TextModel,
  at: number,
  kind: 'i' | 'a',
  key: string,
  count: number,
): Range | null {
  const around = kind === 'a';
  switch (key) {
    case 'w':
      return wordObject(m, at, around, false);
    case 'W':
      return wordObject(m, at, around, true);
    case '"':
    case "'":
    case '`':
      return quoteObject(m, at, key, around);
    default:
      return bracketObject(m, at, key, around, count);
  }
}
