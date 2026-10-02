import { memo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { useStores } from '@/ui/hooks';
import { MessageList } from './list/MessageList';
import styles from './MessagePane.module.css';

/**
 * The message area: the virtualised history of one conversation. Not a
 * named region of its own (the chat column already is one); the feed inside
 * carries the name.
 */
export const MessagePane = memo(function MessagePane({
  conversationId,
}: {
  conversationId: ConversationId;
}) {
  const stores = useStores();
  const exists = useStore(stores.conversations, (s) => conversationId in s.byId);
  if (!exists) return null;
  return (
    <div className={styles.pane} data-shrike="message-pane">
      <MessageList conversationId={conversationId} />
    </div>
  );
});
