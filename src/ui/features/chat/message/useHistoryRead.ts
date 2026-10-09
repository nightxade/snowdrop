import { useEffect, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { Message } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';

/** Overscanned rows are mounted before they are visible; only visibility starts a timer. */
export function useHistoryRead(
  row: RefObject<HTMLElement | null>,
  message: Message | undefined,
): void {
  const { stores, sync } = useSnowdrop();
  const focused = useStore(stores.ui, (state) => state.windowFocused);
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const id = message?.id;
  const conversationId = message?.conversationId;
  const pending =
    !!message?.expiresAfterReadMs &&
    !!message.historyCursor &&
    message.expiresAt === undefined &&
    !message.deleted;
  useEffect(() => {
    const element = row.current;
    if (!element || !id || !conversationId || !pending || !focused || selected !== conversationId)
      return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      const ui = stores.ui.getState();
      if (
        active &&
        ui.windowFocused &&
        uiSelectors.selectedConversation(ui) === conversationId &&
        entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)
      )
        void sync.readHistoryMessages(conversationId, [id]);
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [row, id, conversationId, pending, focused, selected, sync, stores]);
}
