import { X } from 'lucide-react';
import type { ConversationView } from '@/core/domain';
import { useShellLayout, useStores } from '@/ui/hooks';
import { IconButton } from '@/ui/primitives';
import { MemberList } from './MemberList';
import styles from './MembersPanel.module.css';

/** The member column; below 1100px the shell shows it as an overlay sheet. */
export function MembersPanel({ conversation }: { conversation: ConversationView }) {
  const stores = useStores();
  const { narrow } = useShellLayout();
  return (
    <aside
      className={styles.panel}
      data-sheet={narrow ? '' : undefined}
      aria-label={`Members of ${conversation.title}`}
      data-hearth="members"
    >
      {narrow && (
        <header className={styles.header}>
          <span className={styles.title}>Members</span>
          <IconButton
            label="Close member list"
            icon={<X />}
            onClick={() => {
              stores.ui.getState().toggleMemberList(false);
            }}
          />
        </header>
      )}
      <MemberList conversation={conversation} />
    </aside>
  );
}
