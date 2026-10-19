/**
 * Whether the rendered range is close enough to either loaded edge that the
 * next page should be requested now, instead of waiting for the reader to
 * scroll all the way there (`startReached`/`endReached`) and hit a wall
 * while it loads.
 *
 * `rangeChanged` already overscans by `increaseViewportBy` worth of rows, so
 * by the time `startReached` fires the reader is already at the physical
 * top with nothing more to show. Triggering a page or two earlier hides the
 * backend round-trip behind however long it takes to scroll the rest of the
 * way.
 *
 * Kept free of React and the virtualiser so the rule is unit-testable.
 */
export const PREFETCH_ROWS = 24;

export interface PrefetchFlags {
  hasMoreBefore: boolean;
  anchoredToPresent: boolean;
}

export interface PrefetchDecision {
  loadOlder: boolean;
  loadNewer: boolean;
}

/**
 * `range` and `firstItemIndex` are react-virtuoso's own index space (`data[0]`
 * is `firstItemIndex`); `itemCount` is the loaded window's current length.
 */
export function prefetchEdges(
  range: { startIndex: number; endIndex: number },
  firstItemIndex: number,
  itemCount: number,
  flags: PrefetchFlags,
): PrefetchDecision {
  const remainingAbove = range.startIndex - firstItemIndex;
  const remainingBelow = firstItemIndex + itemCount - 1 - range.endIndex;
  return {
    loadOlder: flags.hasMoreBefore && remainingAbove <= PREFETCH_ROWS,
    loadNewer: !flags.anchoredToPresent && remainingBelow <= PREFETCH_ROWS,
  };
}
