import { X } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, MessageId } from '@/core/domain';
import {
  contactsSelectors,
  messagesSelectors,
  UNKNOWN_CONTACT_NAME,
  type ContactsState,
} from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { IconButton } from '@/ui/primitives';
import styles from './ComposerParts.module.css';

export function ReplyBar({
  conversationId,
  messageId,
  onCancel,
}: {
  conversationId: ConversationId;
  messageId: MessageId;
  onCancel: () => void;
}) {
  const stores = useStores();
  const authorId = useStore(
    stores.messages,
    (s) => messagesSelectors.message(conversationId, messageId)(s)?.authorId,
  );
  const name = useStore(stores.contacts, (s: ContactsState) =>
    authorId ? contactsSelectors.displayName(authorId)(s) : UNKNOWN_CONTACT_NAME,
  );
  const color = useStore(stores.contacts, (s: ContactsState) =>
    authorId ? s.byId[authorId]?.color : undefined,
  );
  return (
    <div className={styles.reply} data-snowdrop="reply-bar">
      <span className={styles.replyText}>
        Replying to{' '}
        <strong
          className={styles.replyName}
          style={{ '--name-color': color ?? 'var(--snowdrop-text-strong)' } as CSSProperties}
        >
          {name}
        </strong>
      </span>
      <IconButton size="sm" label="Cancel reply (Esc)" icon={<X />} onClick={onCancel} />
    </div>
  );
}
