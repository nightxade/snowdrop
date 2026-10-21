/**
 * Body + ranges → a nested segment tree for rendering.
 *
 * Signal ranges may overlap arbitrarily (bold 0–5 and italic 3–8), and arrive
 * from the network, so they may also be out of bounds or split surrogate
 * pairs. We normalise everything into a well-nested tree the renderer can map
 * 1:1 onto elements, choosing the nesting that minimises element count.
 */
import {
  MAX_BODY_RANGES,
  MENTION_PLACEHOLDER,
  TEXT_STYLES,
  type BodyRange,
  type TextStyle,
} from './types';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'style'; style: TextStyle; children: Segment[] }
  | {
      type: 'mention';
      mentionId: string;
      /** The raw body text the mention covered (usually U+FFFC). */
      text: string;
    };

export interface Atom {
  start: number;
  end: number;
  styles: ReadonlySet<TextStyle>;
  mentionId?: string;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Moves an index that falls inside a surrogate pair to the pair's end. */
function snap(body: string, index: number): number {
  if (
    index > 0 &&
    index < body.length &&
    isHighSurrogate(body.charCodeAt(index - 1)) &&
    isLowSurrogate(body.charCodeAt(index))
  ) {
    return index + 1;
  }
  return index;
}

export interface CleanRange {
  start: number;
  end: number;
  style?: TextStyle;
  mentionId?: string;
}

/** Index of the first element of `items` (sorted by `key`) whose key is >= `value`. */
function lowerBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid] as T) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Clamps, snaps and filters `ranges`, keeping at most `limit` of them (the
 * rest are dropped: a real message has a handful, see MAX_BODY_RANGES).
 */
/** @internal exported for tests */
export function cleanRanges(
  body: string,
  ranges: readonly BodyRange[],
  limit: number,
): CleanRange[] {
  const out: CleanRange[] = [];
  // Accepted mentions, kept sorted by start. They never overlap, so a new
  // one conflicts only with its two neighbours.
  const mentions: CleanRange[] = [];
  for (const r of ranges) {
    if (out.length >= limit) break;
    if (!Number.isFinite(r.start) || !Number.isFinite(r.length)) continue;
    const start = snap(body, Math.max(0, Math.min(body.length, Math.trunc(r.start))));
    const end = snap(body, Math.max(0, Math.min(body.length, Math.trunc(r.start + r.length))));
    if (end <= start) continue;
    if (r.mentionId !== undefined) {
      // Mentions are atomic and cannot overlap one another: first one wins.
      const at = lowerBound(mentions, start, (m) => m.start);
      const before = mentions[at - 1];
      const after = mentions[at];
      if ((before && before.end > start) || (after && after.start < end)) continue;
      const m = { start, end, mentionId: r.mentionId };
      mentions.splice(at, 0, m);
      out.push(m);
    } else if (r.style !== undefined && TEXT_STYLES.includes(r.style)) {
      out.push({ start, end, style: r.style });
    }
  }
  return out;
}

/**
 * Cuts the body at every range boundary (except inside a mention) and works
 * out which styles/mention cover each piece. O(R log R): sort the cut points,
 * binary-search each range onto the run of atoms it covers, and sweep
 * per-style difference arrays.
 */
/** @internal exported for tests */
export function toAtoms(body: string, ranges: CleanRange[]): Atom[] {
  const mentions = ranges
    .filter((r) => r.mentionId !== undefined)
    .sort((a, b) => a.start - b.start);
  // Mentions are disjoint and sorted: the one containing `i` strictly inside, if any.
  const insideMention = (i: number): boolean => {
    const m = mentions[lowerBound(mentions, i, (x) => x.start) - 1];
    return m !== undefined && i > m.start && i < m.end;
  };

  const cuts = new Set<number>([0, body.length]);
  for (const r of ranges) {
    if (!insideMention(r.start)) cuts.add(r.start);
    if (!insideMention(r.end)) cuts.add(r.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const count = points.length - 1;

  // A range covers atom k iff r.start <= start(k) and r.end >= end(k); the
  // covered atoms are one contiguous run [lo, hi).
  const depth = new Map<TextStyle, Int32Array>();
  const mentionAt = new Map<number, string>();
  for (const r of ranges) {
    const lo = lowerBound(points, r.start, (p) => p);
    // First atom whose end is beyond r.end (atom k ends at points[k + 1]).
    const hi = Math.min(count, lowerBound(points, r.end + 1, (p) => p) - 1);
    if (lo >= hi) continue;
    if (r.style !== undefined) {
      let diff = depth.get(r.style);
      if (!diff) {
        diff = new Int32Array(count + 1);
        depth.set(r.style, diff);
      }
      diff[lo] = (diff[lo] as number) + 1;
      diff[hi] = (diff[hi] as number) - 1;
    }
    // A mention is its own atom: it starts exactly where the range does.
    if (r.mentionId !== undefined && points[lo] === r.start) mentionAt.set(lo, r.mentionId);
  }

  const running = new Map<TextStyle, number>();
  const atoms: Atom[] = [];
  for (let k = 0; k < count; k++) {
    const styles = new Set<TextStyle>();
    for (const [style, diff] of depth) {
      const now = (running.get(style) ?? 0) + (diff[k] as number);
      running.set(style, now);
      if (now > 0) styles.add(style);
    }
    const start = points[k] as number;
    const end = points[k + 1] as number;
    const mentionId = mentionAt.get(k);
    atoms.push(
      mentionId === undefined ? { start, end, styles } : { start, end, styles, mentionId },
    );
  }
  return atoms;
}

function build(body: string, atoms: readonly Atom[], applied: ReadonlySet<TextStyle>): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i] as Atom;
    const pending = [...atom.styles].filter((s) => !applied.has(s));

    if (pending.length === 0) {
      const text = body.slice(atom.start, atom.end);
      if (atom.mentionId !== undefined) {
        out.push({ type: 'mention', mentionId: atom.mentionId, text });
      } else {
        const last = out.at(-1);
        if (last?.type === 'text') last.text += text;
        else out.push({ type: 'text', text });
      }
      i++;
      continue;
    }

    // Wrap the longest run first: fewer, larger elements and a stable shape.
    let best: TextStyle = pending[0] as TextStyle;
    let bestRun = 0;
    for (const style of TEXT_STYLES) {
      if (!pending.includes(style)) continue;
      let run = 0;
      while (i + run < atoms.length && (atoms[i + run] as Atom).styles.has(style)) run++;
      if (run > bestRun) {
        best = style;
        bestRun = run;
      }
    }
    const group = atoms.slice(i, i + bestRun);
    out.push({
      type: 'style',
      style: best,
      children: build(body, group, new Set([...applied, best])),
    });
    i += bestRun;
  }
  return out;
}

/**
 * `limit` bounds how many ranges are considered (default MAX_BODY_RANGES);
 * only tests pass anything else.
 */
export function rangesToSegments(
  body: string,
  ranges: readonly BodyRange[],
  limit: number = MAX_BODY_RANGES,
): Segment[] {
  if (body.length === 0) return [];
  const clean = cleanRanges(body, ranges, limit);
  if (clean.length === 0) return [{ type: 'text', text: body }];
  return build(body, toAtoms(body, clean), new Set());
}

/**
 * Flattens a body to plain text with mentions resolved, e.g. for previews,
 * notifications and "copy text". Stray placeholders without a range are dropped.
 */
export function bodyToPlainText(
  body: string,
  ranges: readonly BodyRange[],
  nameFor: (mentionId: string) => string,
): string {
  const walk = (segments: readonly Segment[]): string =>
    segments
      .map((s) => {
        if (s.type === 'text') return s.text.replaceAll(MENTION_PLACEHOLDER, '');
        if (s.type === 'mention') return `@${nameFor(s.mentionId)}`;
        return walk(s.children);
      })
      .join('');
  return walk(rangesToSegments(body, ranges));
}
