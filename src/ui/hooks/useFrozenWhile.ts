import { useState } from 'react';

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
 */
export function useFrozenWhile<T>(value: T, freeze: boolean, ready = true): T {
  const [snapshot, setSnapshot] = useState<{ freeze: boolean; held: boolean; value: T }>({
    freeze,
    held: freeze && ready,
    value,
  });
  if (freeze !== snapshot.freeze || (freeze && ready && !snapshot.held)) {
    // Entering freeze (or the value turning ready during it): remember `value` now. Leaving it: nothing to remember.
    setSnapshot({ freeze, held: freeze && ready, value });
    return value;
  }
  return freeze ? snapshot.value : value;
}
