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
  const live = useStore(
    stores.messages,
    (s) => messagesSelectors.message(conversationId, messageId)(s)?.authorId,
  );
  // The message may have left the loaded window (scrolled far away); the reply keeps its author.
  const kept = useStore(stores.ui, (s) => {
    const source = s.replySource[conversationId];
    return source?.id === messageId ? source.authorId : undefined;
  });
  const authorId = live ?? kept;
  const name = useStore(stores.contacts, (s: ContactsState) =>
    authorId ? contactsSelectors.displayName(authorId)(s) : UNKNOWN_CONTACT_NAME,
  );
  const color = useStore(stores.contacts, (s: ContactsState) =>
    authorId ? s.byId[authorId]?.color : undefined,
  );
  return (
    <div
      className={styles.reply}
      data-snowdrop="reply-bar"
      // The button says "Esc": with focus on it, Esc cancels the reply, as it does in the field.
      // Not conditional on `defaultPrevented`: the button's own tooltip claims that Esc first and
      // must not cost a press.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        onCancel();
      }}
    >
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
