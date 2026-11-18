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
  /**
   * The list is held where it opened, at the unread divider (C5): the older page waits for the reader
   * to move it. The divider is the first row of the loaded unread run, so a page of older unread
   * messages moves it relative to the rows, and the view would have to be put back on it.
   */
  holdOlder?: boolean;
}

export interface PrefetchDecision {
  loadOlder: boolean;
  /** An older page is due but held back (`holdOlder`): request it when the reader moves the list. */
  deferOlder: boolean;
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
  const olderDue = flags.hasMoreBefore && remainingAbove <= PREFETCH_ROWS;
  return {
    loadOlder: olderDue && !flags.holdOlder,
    deferOlder: olderDue && flags.holdOlder === true,
    loadNewer: !flags.anchoredToPresent && remainingBelow <= PREFETCH_ROWS,
  };
}
