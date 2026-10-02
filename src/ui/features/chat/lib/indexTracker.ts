/**
 * Keeps react-virtuoso's `firstItemIndex` consistent as the message window
 * changes, so prepending older history (or evicting from the top) never
 * moves what's on screen.
 *
 * Virtuoso identifies rows by *absolute* index (`firstItemIndex + i`) and
 * keeps the scroll position when the rows at those indices keep their
 * identity. We find the first row of the new list that already existed and
 * shift `firstItemIndex` by how far it moved. Keys are stable per message
 * (nonce or id, ordered by `seq`), so this also survives day dividers that
 * move to a newly prepended first message.
 *
 * When nothing overlaps (first load, a jump to an old message, jump to
 * present from far away) it's a new list altogether: `epoch` increments so
 * the caller can remount the virtualiser at the right starting position.
 */
export interface IndexedItem {
  key: string;
}

export interface TrackedIndex {
  firstItemIndex: number;
  /** Increments whenever the list was replaced rather than extended. */
  epoch: number;
}

/** Room to prepend ~10M rows before firstItemIndex would reach 0. */
export const INDEX_BASE = 10_000_000;

/** Tracker state: the items it last saw and the index derived for them. */
export interface IndexTrack extends TrackedIndex {
  items: readonly IndexedItem[];
}

export function initialTrack(base = INDEX_BASE): IndexTrack {
  return { items: [], firstItemIndex: base, epoch: 0 };
}

/**
 * Pure step: the track for `items` given the previous track. Callers hold
 * the result as React state (derived during render, before the virtualiser
 * sees the new data), so nothing outside React is mutated while rendering.
 */
export function advanceTrack(
  previous: IndexTrack,
  items: readonly IndexedItem[],
  base = INDEX_BASE,
): IndexTrack {
  if (items === previous.items) return previous;
  const oldIndex = new Map<string, number>();
  previous.items.forEach((item, i) => oldIndex.set(item.key, i));
  let shift: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const old = oldIndex.get((items[i] as IndexedItem).key);
    if (old !== undefined) {
      shift = i - old;
      break;
    }
  }
  if (shift === null) {
    if (previous.items.length === 0 && items.length === 0) return { ...previous, items };
    return { items, firstItemIndex: base, epoch: previous.epoch + 1 };
  }
  return { items, firstItemIndex: previous.firstItemIndex - shift, epoch: previous.epoch };
}

/** Stateful convenience wrapper (tests, non-React callers). */
export function createIndexTracker(
  base = INDEX_BASE,
): (items: readonly IndexedItem[]) => TrackedIndex {
  let track = initialTrack(base);
  return (items) => {
    track = advanceTrack(track, items, base);
    return { firstItemIndex: track.firstItemIndex, epoch: track.epoch };
  };
}
