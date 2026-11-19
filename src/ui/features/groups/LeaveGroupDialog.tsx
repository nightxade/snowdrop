import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  colorForId,
  isGroupMember,
  mustChooseNewAdmin,
  type Contact,
  type ConversationId,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { ConfirmDialog } from '@/ui/primitives';
import { ContactChecklist } from './ContactChecklist';
import { useCloseWhenImpossible } from './useCloseWhenImpossible';
import { nameOf, useGroup } from './useGroup';

/**
 * Leave a group, after asking. The only admin has to hand the role to at
 * least one other member first (Desktop and signal-cli both insist).
 */
export function LeaveGroupDialog({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, selfId } = useGroup(conversationId);
  const contactsById = useStore(app.stores.contacts, (s) => s.byId);
  // Our own leaving is what makes it impossible: that is no reason to close with a notice.
  const leaving = useRef(false);
  useCloseWhenImpossible(isGroupMember(group, selfId), onClose, {
    message: 'You are no longer in this group.',
    acting: leaving,
  });
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const others = useMemo<Contact[]>(
    () =>
      (group?.memberIds ?? [])
        .filter((id) => id !== selfId)
        .map(
          (id) => contactsById[id] ?? { id, name: nameOf(contactsById, id), color: colorForId(id) },
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [group, selfId, contactsById],
  );
  if (!group) return null;
  const needsAdmin = mustChooseNewAdmin(group, selfId);
  return (
    <ConfirmDialog
      title={`Leave “${stripBidiControls(group.title)}”?`}
      description={
        needsAdmin
          ? 'You are the only admin. Before you leave, choose at least one new admin for this group.'
          : 'You will no longer be able to send or receive messages in this group.'
      }
      confirmLabel="Leave group"
      busyLabel="Leaving…"
      danger
      disabled={needsAdmin && picked.size === 0}
      run={async () => {
        leaving.current = true;
        try {
          return await app.groups.leave(conversationId, [...picked]);
        } finally {
          leaving.current = false;
        }
      }}
      onClose={onClose}
    >
      {needsAdmin && (
        <ContactChecklist
          contacts={others}
          selected={picked}
          onChange={setPicked}
          label="New admins"
          searchLabel="Search members"
          empty="No other members."
        />
      )}
    </ConfirmDialog>
  );
}
