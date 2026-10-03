import { X } from 'lucide-react';
import { memo } from 'react';
import type { ConversationId } from '@/core/domain';
import { IconButton } from '@/ui/primitives';
import { MemberList } from './MemberList';
import styles from './MembersPanel.module.css';

/**
 * The member column. With `onClose` it's the narrow-layout sheet (rendered
 * inside a modal Drawer by the chat column) and shows a header with a close
 * button.
 */
export const MembersPanel = memo(function MembersPanel({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose?: () => void;
}) {
  return (
    <aside
      className={styles.panel}
      data-sheet={onClose ? '' : undefined}
      aria-label="Members"
      data-snowdrop="members"
    >
      {onClose && (
        <header className={styles.header}>
          <span className={styles.title}>Members</span>
          <IconButton label="Close member list" icon={<X />} onClick={onClose} />
        </header>
      )}
      <MemberList conversationId={conversationId} />
    </aside>
  );
});
