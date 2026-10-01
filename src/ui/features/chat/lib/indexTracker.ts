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

export function createIndexTracker(
  base = INDEX_BASE,
): (items: readonly IndexedItem[]) => TrackedIndex {
  let previous: readonly IndexedItem[] = [];
  let state: TrackedIndex = { firstItemIndex: base, epoch: 0 };
  return (items) => {
    if (items === previous) return state;
    const oldIndex = new Map<string, number>();
    previous.forEach((item, i) => oldIndex.set(item.key, i));
    let shift: number | null = null;
    for (let i = 0; i < items.length; i++) {
      const old = oldIndex.get((items[i] as IndexedItem).key);
      if (old !== undefined) {
        shift = i - old;
        break;
      }
    }
    if (shift === null) {
      state =
        previous.length === 0 && items.length === 0
          ? state
          : { firstItemIndex: base, epoch: state.epoch + 1 };
    } else if (shift !== 0) {
      state = { ...state, firstItemIndex: state.firstItemIndex - shift };
    }
    previous = items;
    return state;
  };
}
