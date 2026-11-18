import { useState } from 'react';
import { useStores } from './SnowdropContext';

/**
 * Returns `value`, except once `freeze` becomes true it keeps returning the
 * value from the moment it became true, until `freeze` goes back to false
 * (then it tracks `value` live again).
 *
 * Used for the sidebar's "catching up" freeze (PLAN: previews, order and
 * unread badges hold still while signal-cli drains old envelopes, then
 * update all at once) — see `useSidebarModel` and `useRowState`. Stores the
 * snapshot in state rather than a ref: this is the React-documented
 * "adjusting state when a prop changes" pattern (calling `setState`
 * conditionally during render), which, unlike a ref write, is safe to do
 * during render.
 *
 * `ready` says whether `value` is worth freezing yet. A freeze that starts
 * while it is false (the sidebar's conversations not loaded at the first
 * catch-up) takes its snapshot from the first render where it is true, so it
 * never freezes an empty placeholder.
 *
 * `keep` also stores the snapshot outside the component, under its key, so a
 * component that is unmounted and mounted again during the freeze (the sidebar
 * moving into the drawer and back, a row scrolled away and in again) picks the
 * held value up instead of taking a new one. The owner of the shelf decides
 * when the freeze is over and empties it (see `useCatchUpShelf`).
 */
export function useFrozenWhile<T>(value: T, freeze: boolean, ready = true, keep?: FreezeKeep): T {
  const [snapshot, setSnapshot] = useState<{ freeze: boolean; held: boolean; value: T }>(() => {
    if (freeze && keep?.shelf.has(keep.key))
      return { freeze, held: true, value: keep.shelf.get(keep.key) as T };
    return { freeze, held: freeze && ready, value };
  });
  if (freeze !== snapshot.freeze || (freeze && ready && !snapshot.held)) {
    // Entering freeze (or the value turning ready during it): remember `value` now. Leaving it: nothing to remember.
    const held = freeze && ready;
    if (held && keep) keep.shelf.set(keep.key, value);
    setSnapshot({ freeze, held, value });
    return value;
  }
  return freeze ? snapshot.value : value;
}

/** Where a frozen value is also kept, outside the component (see `useFrozenWhile`). */
export interface FreezeKeep {
  shelf: Map<string, unknown>;
  key: string;
}

const shelves = new WeakMap<object, Map<string, unknown>>();

/**
 * The shelf for the catch-up freeze: held snapshots live as long as the
 * catch-up does and are dropped the moment it ends, so nothing stays frozen
 * after it and the next catch-up starts from a fresh snapshot.
 */
export function useCatchUpShelf(): Map<string, unknown> {
  const { session } = useStores();
  let shelf = shelves.get(session);
  if (!shelf) {
    const made = new Map<string, unknown>();
    shelf = made;
    shelves.set(session, made);
    session.subscribe((state) => {
      if (!state.catchingUp) made.clear();
    });
  }
  return shelf;
}
