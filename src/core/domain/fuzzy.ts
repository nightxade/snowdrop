/**
 * Small fuzzy matcher for the quick switcher.
 *
 * A dependency-free subsequence scorer tuned for short labels (conversation
 * titles, command names): it rewards prefix, word-start and consecutive
 * matches and penalises gaps, so "clb" ranks "Climbing Club" above
 * "Cool Library". Matching is case- and diacritic-insensitive.
 */

export interface FuzzyMatch {
  score: number;
  /** UTF-16 indices into the candidate of each matched character. */
  indices: number[];
}

const fold = (ch: string): string => ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const isBoundary = (prev: string | undefined, ch: string): boolean => {
  if (prev === undefined) return true;
  if (/[\s\-_./#@:]/u.test(prev)) return true;
  // camelCase boundary
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
};

const SCORE = {
  match: 1,
  consecutive: 5,
  wordStart: 8,
  firstChar: 10,
  gapPenalty: 0.5,
  maxGapPenalty: 3,
  exact: 100,
  prefix: 30,
} as const;

/** Returns the best match of `query` in `candidate`, or null if it does not match. */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  let q = '';
  // Fold per code point: NFD expansion must not split surrogate pairs.
  for (const ch of query.trim()) q += fold(ch);
  if (q.length === 0) return { score: 0, indices: [] };

  // Fold per code point while remembering original UTF-16 offsets.
  const chars: { ch: string; index: number; raw: string }[] = [];
  let offset = 0;
  for (const raw of candidate) {
    chars.push({ ch: fold(raw), index: offset, raw });
    offset += raw.length;
  }
  const folded = chars.map((c) => c.ch).join('');

  // Greedy forward pass, preferring word-start positions when available.
  const indices: number[] = [];
  let score = 0;
  let ci = 0;
  let lastMatch = -2;
  for (const qc of q) {
    let found = -1;
    // Look ahead for a word-start occurrence before settling for any.
    for (let k = ci; k < chars.length; k++) {
      const c = chars[k];
      if (c?.ch === qc && isBoundary(chars[k - 1]?.raw, c.raw)) {
        found = k;
        break;
      }
    }
    // A consecutive match beats jumping to a later word start.
    if (chars[ci]?.ch === qc && lastMatch === ci - 1) found = ci;
    if (found === -1) {
      for (let k = ci; k < chars.length; k++) {
        if (chars[k]?.ch === qc) {
          found = k;
          break;
        }
      }
    }
    if (found === -1) return null;

    const c = chars[found] as (typeof chars)[number];
    score += SCORE.match;
    if (found === 0) score += SCORE.firstChar;
    if (isBoundary(chars[found - 1]?.raw, c.raw)) score += SCORE.wordStart;
    if (found === lastMatch + 1) score += SCORE.consecutive;
    else if (lastMatch >= 0)
      score -= Math.min(SCORE.maxGapPenalty, (found - lastMatch - 1) * SCORE.gapPenalty);
    indices.push(c.index);
    lastMatch = found;
    ci = found + 1;
  }

  if (folded === q) score += SCORE.exact;
  else if (folded.startsWith(q)) score += SCORE.prefix;
  // Prefer shorter candidates when everything else is equal.
  score -= chars.length * 0.01;

  return { score, indices };
}

/** Convenience wrapper: score or null when the query does not match. */
export function fuzzyScore(query: string, candidate: string): number | null {
  return fuzzyMatch(query, candidate)?.score ?? null;
}

/** Filters and sorts items by fuzzy score (stable for equal scores). */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; order: number }[] = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, toText(item));
    if (match) out.push({ item, match, order });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return out.map(({ item, match }) => ({ item, match }));
}
