import { useEffect, useRef, type RefObject } from 'react';
import { useSnowdrop } from '@/ui/hooks';

export const CANNOT_CHANGE_GROUP = 'You can no longer change this group.';

/**
 * A group dialog that was usable when it opened closes, with a short toast, once what it does is
 * no longer possible (you were made a plain member, left on another device, the group went):
 * leaving it open would only ever refuse. A dialog that opened read-only stays; so does one
 * whose own action is running (`acting`), whose result it shows itself. Focus is handed on as
 * for any closing dialog (M15).
 */
export function useCloseWhenImpossible(
  possible: boolean,
  onClose: () => void,
  options: { message?: string; acting?: RefObject<boolean> } = {},
): void {
  const { stores } = useSnowdrop();
  const usable = useRef(possible);
  const closed = useRef(false);
  const latest = useRef({ onClose, options });
  useEffect(() => {
    latest.current = { onClose, options };
  });
  useEffect(() => {
    if (possible) {
      usable.current = true;
      return;
    }
    const { onClose: close, options: o } = latest.current;
    if (!usable.current || closed.current || o.acting?.current) return;
    closed.current = true;
    stores.ui.getState().pushToast({
      message: o.message ?? CANNOT_CHANGE_GROUP,
      kind: 'info',
      source: 'core',
    });
    close();
  }, [possible, stores]);
}
