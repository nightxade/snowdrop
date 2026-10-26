import type { ReactNode } from 'react';
import { Copy, KeyRound, Link2, LogOut, Pencil, Timer, UserPlus } from 'lucide-react';
import { useStore } from 'zustand';
import {
  canAddMembers,
  canEditGroupInfo,
  canManageGroup,
  formatDuration,
  isGroupMember,
  type ConversationView,
} from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import {
  ConversationAvatar,
  copyText,
  openGroupModal,
  usePeer,
  type GroupModalType,
} from '@/ui/features/conversation';
import { Button, PopoverClose } from '@/ui/primitives';
import styles from './ConversationDetails.module.css';

/**
 * The "about this conversation" popover opened from the header title. For a
 * group it is also where its settings start: edit, add members, link,
 * permissions and leave, each shown only when our role allows it (the same
 * split Signal Desktop makes).
 */
export function ConversationDetails({ conversation }: { conversation: ConversationView }) {
  const app = useSnowdrop();
  const peer = usePeer(conversation);
  const selfId = useStore(app.stores.session, sessionSelectors.selfId);
  const isGroup = conversation.kind === 'group';
  const about = isGroup ? conversation.description : peer?.about;
  const manageable = isGroup && app.groups.available;
  const canEdit = manageable && canEditGroupInfo(conversation, selfId);
  const canAdd = manageable && canAddMembers(conversation, selfId);
  const canManage = manageable && canManageGroup(conversation, selfId);
  // Anyone can see and copy the link while it is on; only an admin turns it on.
  const showLink = manageable && (canManage || conversation.inviteLink !== undefined);
  const canLeave = manageable && isGroupMember(conversation, selfId);
  const left = conversation.left === true;
  const announcement = conversation.permissions?.sendMessages === 'only-admins';

  const open = (type: GroupModalType) => () => {
    openGroupModal(app, type, { conversationId: conversation.id });
  };
  const action = (
    type: GroupModalType,
    label: string,
    icon: ReactNode,
    value?: string,
    danger = false,
  ) => (
    <li>
      <PopoverClose asChild>
        <Button
          size="sm"
          variant={danger ? 'danger' : 'ghost'}
          fullWidth
          className={styles.action}
          icon={icon}
          onClick={open(type)}
        >
          <span className={styles.actionLabel}>{label}</span>
          {value && <span className={styles.actionValue}>{value}</span>}
        </Button>
      </PopoverClose>
    </li>
  );

  return (
    <div className={styles.details}>
      <div className={styles.top}>
        <ConversationAvatar conversation={conversation} size={48} />
        <div className={styles.names}>
          <p className={styles.title}>{conversation.title}</p>
          <p className={styles.meta}>
            {isGroup
              ? `Group, ${conversation.memberIds.length} members`
              : (peer?.number ?? 'Direct message')}
          </p>
        </div>
      </div>
      {about && <p className={styles.about}>{about}</p>}
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>
            <Timer size={14} aria-hidden /> Disappearing messages
          </dt>
          <dd>{formatDuration(conversation.expireTimerSec)}</dd>
        </div>
        {left && (
          <div className={styles.fact}>
            <dt>Your membership</dt>
            <dd>You left this group</dd>
          </div>
        )}
        {announcement && !left && (
          <div className={styles.fact}>
            <dt>Who can send messages</dt>
            <dd>Only admins</dd>
          </div>
        )}
      </dl>
      {(canEdit || canAdd || showLink || canManage) && (
        <ul className={styles.actionList} aria-label="Group settings">
          {canEdit && action('editGroup', 'Edit group', <Pencil size={14} />)}
          {canAdd && action('addMembers', 'Add members', <UserPlus size={14} />)}
          {showLink &&
            action(
              'groupLink',
              'Group link',
              <Link2 size={14} />,
              conversation.inviteLink ? 'On' : 'Off',
            )}
          {canManage && action('groupPermissions', 'Permissions', <KeyRound size={14} />)}
        </ul>
      )}
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          icon={<Copy size={14} />}
          onClick={() => {
            void copyText(app, conversation.id, 'conversation ID');
          }}
        >
          Copy ID
        </Button>
        {canLeave && (
          <PopoverClose asChild>
            <Button
              size="sm"
              variant="danger"
              icon={<LogOut size={14} />}
              onClick={open('leaveGroup')}
            >
              Leave group
            </Button>
          </PopoverClose>
        )}
      </div>
    </div>
  );
}
