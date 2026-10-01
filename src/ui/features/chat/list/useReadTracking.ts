import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { conversationsSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';

/**
 * Read state follows what's actually on screen: a conversation is marked
 * read only while its newest message is visible and the window has focus.
 * The same fact is published to the ui store, so the sync engine auto-reads
 * arrivals only then (and leaves them unread while you're scrolled up).
 */
export function useReadTracking(conversationId: ConversationId, atPresent: boolean): void {
  const { stores, sync } = useHearth();
  const focused = useStore(stores.ui, (s) => s.windowFocused);
  const unread = useStore(stores.conversations, conversationsSelectors.unread(conversationId));
  const hasUnread = unread.count > 0 || unread.mentions > 0;

  useEffect(() => {
    stores.ui.getState().setScrolledUp(conversationId, !atPresent);
  }, [stores, conversationId, atPresent]);

  useEffect(
    () => () => {
      stores.ui.getState().setScrolledUp(conversationId, false);
    },
    [stores, conversationId],
  );

  useEffect(() => {
    if (atPresent && focused && hasUnread) void sync.markConversationRead(conversationId);
  }, [atPresent, focused, hasUnread, sync, conversationId]);
}
