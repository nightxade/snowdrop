import { X } from 'lucide-react';
import { memo } from 'react';
import type { ConversationId } from '@/core/domain';
import { useHandOffFocus } from '@/ui/hooks';
import { focusQuietly, IconButton } from '@/ui/primitives';
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
  // The inline column closed by its shortcut with focus in it: focus goes to the header's toggle,
  // where the sheet's close returns it. The sheet hands focus back itself.
  useHandOffFocus(
    '[data-snowdrop="members"]',
    () => {
      focusQuietly(document.querySelector<HTMLElement>('[data-snowdrop="member-toggle"]'));
    },
    !onClose,
  );
  return (
    <aside
      className={styles.panel}
      data-sheet={onClose ? '' : undefined}
      aria-label="Members"
      data-snowdrop="members"
      data-pane-title="members"
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
