import { useEffect, useRef } from 'react';
import { isPendingMessageId, type RenderItem } from '@/core/domain';
import type { BottomPin } from './bottomPin';

/**
 * Whether the newest row just became a message the user is sending (a
 * pending row appended to the list that was already showing). A list that is
 * only being opened (a different `epoch`, or nothing shown before) never
 * counts: it decides where to start by itself.
 */
export function startedOwnSend(
  previous: { epoch: number; key: string | undefined } | null,
  next: { epoch: number; key: string | undefined; pending: boolean },
): boolean {
  return (
    next.pending && previous !== null && previous.epoch === next.epoch && previous.key !== next.key
  );
}

interface Options {
  items: readonly RenderItem[];
  epoch: number;
  anchoredToPresent: boolean;
  pin: BottomPin;
  scrollTopNow: () => number | undefined;
  scrollToBottom: () => void;
}

/**
 * Sending always shows the message: the moment its pending row appears the
 * list holds the bottom and scrolls to it, wherever the reader was. Waiting
 * for the send to finish (the composer's own jump) left the new message below
 * the fold for as long as the network took.
 */
export function useFollowOwnSend({
  items,
  epoch,
  anchoredToPresent,
  pin,
  scrollTopNow,
  scrollToBottom,
}: Options): void {
  const last = items.at(-1);
  const key = last?.key;
  const pending = last?.type === 'message' && isPendingMessageId(last.id);
  const seen = useRef<{ epoch: number; key: string | undefined } | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = { epoch, key };
    if (!anchoredToPresent || !startedOwnSend(previous, { epoch, key, pending })) return;
    pin.beginFollow(scrollTopNow());
    requestAnimationFrame(scrollToBottom);
  }, [epoch, key, pending, anchoredToPresent, pin, scrollTopNow, scrollToBottom]);
}
