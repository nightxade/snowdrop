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
 */
export function useFrozenWhile<T>(value: T, freeze: boolean): T {
  const [snapshot, setSnapshot] = useState<{ freeze: boolean; value: T }>({ freeze, value });
  if (freeze !== snapshot.freeze) {
    // Entering freeze: remember `value` now. Leaving it: nothing to remember.
    setSnapshot({ freeze, value });
    return value;
  }
  return freeze ? snapshot.value : value;
}
