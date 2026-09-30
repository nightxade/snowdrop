/**
 * Body + ranges → a nested segment tree for rendering.
 *
 * Signal ranges may overlap arbitrarily (bold 0–5 and italic 3–8), and arrive
 * from the network, so they may also be out of bounds or split surrogate
 * pairs. We normalise everything into a well-nested tree the renderer can map
 * 1:1 onto elements, choosing the nesting that minimises element count.
 */
import { MENTION_PLACEHOLDER, TEXT_STYLES, type BodyRange, type TextStyle } from './types';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'style'; style: TextStyle; children: Segment[] }
  | {
      type: 'mention';
      mentionId: string;
      /** The raw body text the mention covered (usually U+FFFC). */
      text: string;
    };

interface Atom {
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

interface CleanRange {
  start: number;
  end: number;
  style?: TextStyle;
  mentionId?: string;
}

function cleanRanges(body: string, ranges: readonly BodyRange[]): CleanRange[] {
  const out: CleanRange[] = [];
  const mentions: CleanRange[] = [];
  for (const r of ranges) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.length)) continue;
    const start = snap(body, Math.max(0, Math.min(body.length, Math.trunc(r.start))));
    const end = snap(body, Math.max(0, Math.min(body.length, Math.trunc(r.start + r.length))));
    if (end <= start) continue;
    if (r.mentionId !== undefined) {
      // Mentions are atomic and cannot overlap one another: first one wins.
      if (mentions.some((m) => start < m.end && end > m.start)) continue;
      const m = { start, end, mentionId: r.mentionId };
      mentions.push(m);
      out.push(m);
    } else if (r.style !== undefined && TEXT_STYLES.includes(r.style)) {
      out.push({ start, end, style: r.style });
    }
  }
  return out;
}

function toAtoms(body: string, ranges: CleanRange[]): Atom[] {
  const mentions = ranges.filter((r) => r.mentionId !== undefined);
  const insideMention = (i: number): boolean => mentions.some((m) => i > m.start && i < m.end);

  const cuts = new Set<number>([0, body.length]);
  for (const r of ranges) {
    if (!insideMention(r.start)) cuts.add(r.start);
    if (!insideMention(r.end)) cuts.add(r.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const atoms: Atom[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const start = points[k] as number;
    const end = points[k + 1] as number;
    const styles = new Set<TextStyle>();
    let mentionId: string | undefined;
    for (const r of ranges) {
      if (r.start <= start && r.end >= end) {
        if (r.style) styles.add(r.style);
        if (r.mentionId !== undefined && r.start === start) mentionId = r.mentionId;
      }
    }
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

export function rangesToSegments(body: string, ranges: readonly BodyRange[]): Segment[] {
  if (body.length === 0) return [];
  const clean = cleanRanges(body, ranges);
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
