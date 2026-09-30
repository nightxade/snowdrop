import { CirclePlus, Smile } from 'lucide-react';
import { useStore } from 'zustand';
import type { ConversationView } from '@/core/domain';
import { describeTypers, sessionSelectors, typingSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { IconButton, TypingDots } from '@/ui/primitives';
import styles from './ComposerShell.module.css';

/**
 * The composer's frame: field, attach and emoji buttons and the typing strip
 * (height reserved so it never shifts the layout). Input is disabled until P3
 * wires the editor into `.field`.
 */
export function ComposerShell({ conversation }: { conversation: ConversationView }) {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const typers = useStore(stores.typing, typingSelectors.typers(conversation.id));
  const contacts = useStore(stores.contacts, (s) => s.byId);
  const names = typers
    .filter((id) => id !== selfId)
    .map((id) => contacts[id]?.name.split(' ')[0] ?? 'Someone');
  const typing = describeTypers(names);
  const placeholder =
    conversation.kind === 'group'
      ? `Message #${conversation.title}`
      : `Message @${conversation.title}`;

  return (
    <div className={styles.composer} data-hearth="composer">
      <div className={styles.field} aria-disabled="true">
        <IconButton label="Attach a file" icon={<CirclePlus />} disabled />
        <span className={styles.placeholder}>{placeholder}</span>
        <IconButton label="Emoji" icon={<Smile />} disabled />
      </div>
      <div className={styles.typing} aria-live="polite">
        {typing && (
          <>
            <TypingDots />
            <span>{typing}</span>
          </>
        )}
      </div>
    </div>
  );
}
