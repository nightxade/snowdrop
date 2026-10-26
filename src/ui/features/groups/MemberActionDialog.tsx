import { useStore } from 'zustand';
import type { GroupChange } from '@/core/backend';
import type { ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import type { GroupMemberAction } from '@/ui/features/conversation';
import { useSnowdrop } from '@/ui/hooks';
import { ActionDialog } from './ActionDialog';
import { nameOf, useGroup } from './useGroup';

interface Copy {
  title: (who: string) => string;
  body: (who: string, group: string) => string;
  confirm: string;
  busy: string;
  danger: boolean;
  change: (id: string) => GroupChange;
}

const COPY: Record<GroupMemberAction, Copy> = {
  remove: {
    title: (who) => `Remove ${who} from the group?`,
    body: (who, group) => `${who} will be removed from “${group}”.`,
    confirm: 'Remove from group',
    busy: 'Removing…',
    danger: true,
    change: (id) => ({ removeMemberIds: [id] }),
  },
  'make-admin': {
    title: (who) => `Make ${who} an admin?`,
    body: (who) => `${who} will be able to edit this group and its members.`,
    confirm: 'Make admin',
    busy: 'Saving…',
    danger: false,
    change: (id) => ({ addAdminIds: [id] }),
  },
  'remove-admin': {
    title: (who) => `Remove ${who} as admin?`,
    body: (who) => `${who} will stay in the group but can no longer manage it.`,
    confirm: 'Remove as admin',
    busy: 'Saving…',
    danger: true,
    change: (id) => ({ removeAdminIds: [id] }),
  },
  approve: {
    title: (who) => `Approve request from ${who}?`,
    body: (who, group) => `${who} will join “${group}” and see new messages.`,
    confirm: 'Approve request',
    busy: 'Approving…',
    danger: false,
    change: (id) => ({ addMemberIds: [id] }),
  },
  deny: {
    title: (who) => `Deny request from ${who}?`,
    body: (who, group) => `${who} will not join “${group}”.`,
    confirm: 'Deny request',
    busy: 'Denying…',
    danger: true,
    change: (id) => ({ removeMemberIds: [id] }),
  },
  revoke: {
    title: (who) => `Revoke the invite for ${who}?`,
    body: (who, group) => `${who} will no longer be able to join “${group}” with that invite.`,
    confirm: 'Revoke invite',
    busy: 'Revoking…',
    danger: true,
    change: (id) => ({ removeMemberIds: [id] }),
  },
};

/** Asks before one person-level admin action (remove, promote, demote, approve, deny, revoke), then does it. */
export function MemberActionDialog({
  conversationId,
  memberId,
  action,
  onClose,
}: {
  conversationId: ConversationId;
  memberId: string;
  action: GroupMemberAction;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, canManage } = useGroup(conversationId);
  const contacts = useStore(app.stores.contacts, (s) => s.byId);
  if (!group) return null;
  const copy = COPY[action];
  const who = stripBidiControls(nameOf(contacts, memberId));
  return (
    <ActionDialog
      title={copy.title(who)}
      description={copy.body(who, stripBidiControls(group.title))}
      confirmLabel={copy.confirm}
      busyLabel={copy.busy}
      danger={copy.danger}
      disabled={!canManage}
      run={() => app.groups.update(conversationId, copy.change(memberId))}
      onClose={onClose}
    />
  );
}
