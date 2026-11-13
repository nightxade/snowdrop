import { useCallback, useEffect, useRef, useState } from 'react';
import { isPendingMessageId, type RenderItem } from '@/core/domain';

interface Seen {
  epoch: number;
  items: readonly RenderItem[];
}

/**
 * Whether someone else's message just arrived at the end of the list that
 * was already showing, while the reader is not at the bottom. Opening a
 * list (nothing shown before, or another epoch), the user's own sends, a
 * message deleted from the end and a window not anchored to the present
 * never count; a reader at the bottom is followed instead of notified.
 */
export function arrivedBelow(
  previous: Seen | null,
  next: {
    epoch: number;
    items: readonly RenderItem[];
    selfId: string | undefined;
    anchoredToPresent: boolean;
    readerAtBottom: boolean;
  },
): boolean {
  if (!next.anchoredToPresent || next.readerAtBottom) return false;
  if (previous === null || previous.epoch !== next.epoch || previous.items.length === 0)
    return false;
  const last = next.items.at(-1);
  if (last?.type !== 'message' || isPendingMessageId(last.id) || last.authorId === next.selfId)
    return false;
  return !previous.items.some((it) => it.key === last.key);
}

interface Options {
  items: readonly RenderItem[];
  epoch: number;
  anchoredToPresent: boolean;
  selfId: string | undefined;
  /** The list's own "reader is at the bottom" (the pin, which also covers its own follow scroll). */
  readerAtBottom: () => boolean;
  /** Virtuoso's at-bottom state: reaching it ends the notice. */
  atBottom: boolean;
}

/**
 * Tracks "new messages arrived below" for the jump pill: set when someone
 * else's message arrives while the reader is scrolled up (the list never
 * moves for it), cleared on reaching the bottom, on `clear()` (a jump) or
 * when the list is replaced.
 */
export function useArrivalsBelow({
  items,
  epoch,
  anchoredToPresent,
  selfId,
  readerAtBottom,
  atBottom,
}: Options): { below: boolean; clear: () => void } {
  const seen = useRef<Seen | null>(null);
  const [state, setState] = useState({ epoch, below: false });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { epoch, items };
    if (
      arrivedBelow(previous, {
        epoch,
        items,
        selfId,
        anchoredToPresent,
        readerAtBottom: readerAtBottom(),
      })
    )
      setState({ epoch, below: true });
  }, [items, epoch, anchoredToPresent, selfId, readerAtBottom]);
  if (atBottom && state.below) setState({ epoch: state.epoch, below: false });
  const clear = useCallback(() => {
    setState((s) => (s.below ? { epoch: s.epoch, below: false } : s));
  }, []);
  return { below: state.below && state.epoch === epoch, clear };
}
