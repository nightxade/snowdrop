import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { conversationsSelectors, localSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';

/**
 * Read state follows what's actually on screen: a conversation is marked
 * read only while its newest message is visible and the window has focus.
 * The same fact is published to the ui store, so the sync engine auto-reads
 * arrivals only then (and leaves them unread while you're scrolled up).
 */
export function useReadTracking(conversationId: ConversationId, atPresent: boolean): void {
  const { stores, sync } = useSnowdrop();
  const focused = useStore(stores.ui, (s) => s.windowFocused);
  const unread = useStore(stores.conversations, conversationsSelectors.unread(conversationId));
  const hasUnread = unread.count > 0 || unread.mentions > 0;
  // Reactions and votes on the user's own messages are read with the chat, though they are no badge.
  const hasActivity = useStore(stores.local, localSelectors.hasUnreadActivity(conversationId));

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
    if (atPresent && focused && (hasUnread || hasActivity))
      void sync.markConversationRead(conversationId);
  }, [atPresent, focused, hasUnread, hasActivity, sync, conversationId]);
}
