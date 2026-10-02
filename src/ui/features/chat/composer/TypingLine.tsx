import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import {
  contactsSelectors,
  describeTypers,
  sessionSelectors,
  typingSelectors,
  type ContactsState,
} from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { TypingDots } from '@/ui/primitives';
import styles from './ComposerParts.module.css';

/** "Alex is typing…", "Alex and Sam are typing…", "Several people are typing…" (first names). */
export function typingText(
  typerIds: readonly string[],
  selfId: string | null,
  contacts: ContactsState['byId'],
): string | null {
  const names = typerIds
    .filter((id) => id !== selfId)
    .map((id) => contacts[id]?.name.split(' ')[0] ?? 'Someone');
  return describeTypers(names);
}

/** Below the field; its height is always reserved so nothing shifts when someone types. */
export function TypingLine({ conversationId }: { conversationId: ConversationId }) {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const typers = useStore(stores.typing, typingSelectors.typers(conversationId));
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const text = typingText(typers, selfId, contacts);
  return (
    <div className={styles.typing} data-shrike="typing-line">
      {text && (
        <>
          <TypingDots />
          <span className={styles.typingText}>{text}</span>
        </>
      )}
    </div>
  );
}
