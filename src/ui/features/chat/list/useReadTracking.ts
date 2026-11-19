import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { conversationsSelectors, localSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';

/**
 * Read state follows what's actually on screen: a conversation is marked
 * read only while its newest message is visible and the window has focus.
 * `atPresent` (the list is at the present and within the follow slack of its
 * end) is published to the ui store, so the sync engine auto-reads arrivals
 * only then (and leaves them unread while you're scrolled up). Messages that
 * are already unread additionally wait for `newestInView`: within the slack
 * the newest ones can still be below the fold, and a reader who has scrolled
 * up and comes back part of the way has not seen them.
 */
export function useReadTracking(
  conversationId: ConversationId,
  atPresent: boolean,
  newestInView: boolean,
): void {
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

  // A chat marked unread by hand is not read for the user while it holds (S8); once they interact
  // with it the flag ends and what arrived meanwhile is read.
  const held = useStore(
    stores.local,
    (s) => s.conversations[conversationId]?.markedUnread === true,
  );

  useEffect(() => {
    if (!held && atPresent && newestInView && focused && (hasUnread || hasActivity))
      void sync.markConversationRead(conversationId);
  }, [held, atPresent, newestInView, focused, hasUnread, hasActivity, sync, conversationId]);
}
