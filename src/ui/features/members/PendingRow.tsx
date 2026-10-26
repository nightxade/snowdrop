import { Check, X } from 'lucide-react';
import { initialsFor, colorForId, type Contact, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { openGroupModal, PersonAvatar, type GroupMemberAction } from '@/ui/features/conversation';
import { useSnowdrop } from '@/ui/hooks';
import { IconButton } from '@/ui/primitives';
import styles from './PendingRow.module.css';

/**
 * Someone who has asked to join through the group link, or been invited and
 * not yet joined. For an admin the row carries the actions (approve or deny a
 * request, revoke an invite); each one asks first, in a dialog.
 */
export function PendingRow({
  id,
  contact,
  kind,
  conversationId,
  canAct,
}: {
  id: string;
  contact: Contact | undefined;
  kind: 'request' | 'invite';
  conversationId: ConversationId;
  canAct: boolean;
}) {
  const app = useSnowdrop();
  const name = contact?.name ?? 'Unknown contact';
  const spoken = stripBidiControls(name);
  const act = (action: GroupMemberAction) => () => {
    openGroupModal(app, 'groupMemberAction', { conversationId, memberId: id, action });
  };
  return (
    <li className={styles.row} data-snowdrop="pending-row">
      <PersonAvatar
        contactId={id}
        conversationId={conversationId}
        fallback={initialsFor(name)}
        color={contact?.color ?? colorForId(id)}
        size={32}
      />
      <span className={styles.name}>{name}</span>
      {canAct && kind === 'request' && (
        <>
          <IconButton
            size="sm"
            label={`Approve request from ${spoken}`}
            icon={<Check />}
            onClick={act('approve')}
          />
          <IconButton
            size="sm"
            label={`Deny request from ${spoken}`}
            icon={<X />}
            onClick={act('deny')}
          />
        </>
      )}
      {canAct && kind === 'invite' && (
        <IconButton
          size="sm"
          label={`Revoke invite for ${spoken}`}
          icon={<X />}
          onClick={act('revoke')}
        />
      )}
    </li>
  );
}
