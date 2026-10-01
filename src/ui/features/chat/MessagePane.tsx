import { memo } from 'react';
import type { ConversationId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { MessageList } from './list/MessageList';
import styles from './MessagePane.module.css';

/** The message area: the virtualised history of one conversation. */
export const MessagePane = memo(function MessagePane({
  conversationId,
}: {
  conversationId: ConversationId;
}) {
  const conversation = useConversationView(conversationId);
  if (!conversation) return null;
  return (
    <section className={styles.pane} data-hearth="message-pane" aria-label="Messages">
      <MessageList conversation={conversation} />
    </section>
  );
});
