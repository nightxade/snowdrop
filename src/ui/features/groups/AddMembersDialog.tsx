import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { composableContacts, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { ContactChecklist } from './ContactChecklist';
import { useGroup } from './useGroup';
import styles from './groups.module.css';

/** Add contacts to a group (Desktop's "Add members"); people already in it are listed but fixed. */
export function AddMembersDialog({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, selfId, canAdd } = useGroup(conversationId);
  const contactsById = useStore(app.stores.contacts, (s) => s.byId);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contacts = useMemo(() => composableContacts(contactsById, selfId), [contactsById, selfId]);
  const unavailable = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of group?.bannedIds ?? []) out[id] = 'Banned from this group';
    for (const id of group?.requestingMemberIds ?? []) out[id] = 'Asking to join';
    for (const id of group?.pendingMemberIds ?? []) out[id] = 'Invited';
    for (const id of group?.memberIds ?? []) out[id] = 'In this group';
    return out;
  }, [group]);
  if (!group) return null;

  const add = async () => {
    if (busy || picked.size === 0 || !canAdd) return;
    setBusy(true);
    setError(null);
    const failure = await app.groups.update(conversationId, { addMemberIds: [...picked] });
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  const count = picked.size;
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Add members"
      description={`Choose who to add to “${stripBidiControls(group.title)}”.`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || count === 0 || !canAdd}
            aria-busy={busy}
            onClick={() => void add()}
          >
            {busy
              ? 'Adding…'
              : count === 0
                ? 'Add members'
                : `Add ${count} ${count === 1 ? 'member' : 'members'}`}
          </Button>
        </>
      }
    >
      <ContactChecklist
        contacts={contacts}
        selected={picked}
        onChange={(next) => {
          setPicked(next);
          setError(null);
        }}
        unavailable={unavailable}
        label="Contacts"
        searchLabel="Search contacts to add"
        disabled={busy}
        empty="No contacts yet."
      />
      <p className={styles.error} role="alert">
        {error}
      </p>
    </Modal>
  );
}
