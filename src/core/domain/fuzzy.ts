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
  gap: 3,
  exact: 100,
  prefix: 30,
} as const;

const NONE = Number.NEGATIVE_INFINITY;

/**
 * Returns the best-scoring match of `query` in `candidate`, or null if the
 * query isn't a subsequence of it.
 *
 * Dynamic programming over (query char, candidate position), O(q·c): unlike a
 * greedy scan it never commits to an early word-start that makes the rest of
 * the query unmatchable ("ma" still finds "Emma Moss").
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  let q = '';
  // Fold per code point: NFD expansion must not split surrogate pairs.
  for (const ch of query.trim()) q += fold(ch);
  if (q.length === 0) return { score: 0, indices: [] };
  const qs = Array.from(q);

  // Fold per code point while remembering original UTF-16 offsets.
  const chars: { ch: string; index: number; bonus: number }[] = [];
  let offset = 0;
  let prevRaw: string | undefined;
  for (const raw of candidate) {
    const position = chars.length;
    const bonus =
      (position === 0 ? SCORE.firstChar : 0) + (isBoundary(prevRaw, raw) ? SCORE.wordStart : 0);
    chars.push({ ch: fold(raw), index: offset, bonus });
    offset += raw.length;
    prevRaw = raw;
  }
  const n = chars.length;
  const m = qs.length;
  if (m > n) return null;

  // at[i][j]: best score with query[i] matched exactly at candidate j.
  // best[i][j]: max of at[i][0..j], with the argmax kept for backtracking.
  const at: Float64Array[] = [];
  const best: Float64Array[] = [];
  const bestIdx: Int32Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const qc = qs[i] as string;
    const row = new Float64Array(n).fill(NONE);
    const rowFrom = new Int32Array(n).fill(-1);
    const prevAt = at[i - 1];
    const prevBest = best[i - 1];
    const prevBestIdx = bestIdx[i - 1];
    for (let j = i; j < n; j++) {
      const c = chars[j] as (typeof chars)[number];
      if (c.ch !== qc) continue;
      const base = SCORE.match + c.bonus;
      if (i === 0) {
        row[j] = base;
        continue;
      }
      const consecutive = j > 0 && prevAt ? (prevAt[j - 1] as number) + SCORE.consecutive : NONE;
      const gapped = j > 1 && prevBest ? (prevBest[j - 2] as number) - SCORE.gap : NONE;
      if (consecutive === NONE && gapped === NONE) continue;
      if (consecutive >= gapped) {
        row[j] = base + consecutive;
        rowFrom[j] = j - 1;
      } else {
        row[j] = base + gapped;
        rowFrom[j] = prevBestIdx ? (prevBestIdx[j - 2] as number) : -1;
      }
    }
    const rowBest = new Float64Array(n);
    const rowBestIdx = new Int32Array(n);
    let running = NONE;
    let runningIdx = -1;
    for (let j = 0; j < n; j++) {
      if ((row[j] as number) > running) {
        running = row[j] as number;
        runningIdx = j;
      }
      rowBest[j] = running;
      rowBestIdx[j] = runningIdx;
    }
    at.push(row);
    best.push(rowBest);
    bestIdx.push(rowBestIdx);
    from.push(rowFrom);
  }

  const lastBest = best[m - 1];
  const lastIdx = bestIdx[m - 1];
  if (!lastBest || !lastIdx) return null;
  let score = lastBest[n - 1] as number;
  if (score === NONE) return null;

  const positions: number[] = [];
  for (let i = m - 1, j = lastIdx[n - 1] as number; i >= 0 && j >= 0; i--) {
    positions.push(j);
    j = (from[i] as Int32Array)[j] as number;
  }
  positions.reverse();

  const folded = chars.map((c) => c.ch).join('');
  if (folded === q) score += SCORE.exact;
  else if (folded.startsWith(q)) score += SCORE.prefix;
  // Prefer shorter candidates when everything else is equal.
  score -= n * 0.01;

  return { score, indices: positions.map((p) => (chars[p] as (typeof chars)[number]).index) };
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
