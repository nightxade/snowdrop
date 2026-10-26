import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { colorForId, mustChooseNewAdmin, type Contact, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { ActionDialog } from './ActionDialog';
import { ContactChecklist } from './ContactChecklist';
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
    <ActionDialog
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
      run={() => app.groups.leave(conversationId, [...picked])}
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
    </ActionDialog>
  );
}
