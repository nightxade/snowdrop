import { useMemo, useRef, useState, type SubmitEvent } from 'react';
import { useStore } from 'zustand';
import {
  colorForId,
  composableContacts,
  GROUP_LIMITS,
  normalizeGroupTitle,
  type ConversationId,
} from '@/core/domain';
import { graphemes, truncateToLimits } from '@/core/lib';
import { conversationFocusTarget, useSnowdrop } from '@/ui/hooks';
import { openConversation } from '@/ui/features/conversation';
import { Button, Modal, TextInput } from '@/ui/primitives';
import { ContactChecklist } from './ContactChecklist';
import { GroupPhotoField, type StagedPhoto } from './GroupPhotoField';
import styles from './groups.module.css';

/**
 * New group, in Desktop's two steps: choose members, then name it (with an
 * optional photo). Making it opens it, with the composer ready.
 */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const app = useSnowdrop();
  const contactsById = useStore(app.stores.contacts, (s) => s.byId);
  const selfId = useStore(app.stores.session, (s) => s.self?.id ?? null);
  const [step, setStep] = useState<'members' | 'details'>('members');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [title, setTitle] = useState('');
  const [photo, setPhoto] = useState<StagedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Focus goes to the new group's composer once the dialog has closed. */
  const target = useRef<ConversationId | null>(null);
  const contacts = useMemo(() => composableContacts(contactsById, selfId), [contactsById, selfId]);

  const name = normalizeGroupTitle(title);
  const create = async (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (busy || !name) return;
    setBusy(true);
    setError(null);
    const result = await app.groups.create({
      title: name,
      memberIds: [...picked],
      ...(photo ? { avatar: photo.dataUri } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    target.current = result.id;
    openConversation(app, result.id);
    onClose();
  };

  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={step === 'members' ? 'New group' : 'Name this group'}
      description={
        step === 'members'
          ? 'Choose who to start the group with. You can add more people later.'
          : `${picked.size} ${picked.size === 1 ? 'member' : 'members'} and you.`
      }
      returnFocus={() => (target.current ? conversationFocusTarget(target.current, true) : null)}
      footer={
        step === 'members' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setStep('details');
              }}
            >
              {picked.size === 0 ? 'Next without members' : 'Next'}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStep('members');
                setError(null);
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="new-group-form"
              disabled={busy || !name}
              aria-busy={busy}
            >
              {busy ? 'Creating…' : 'Create group'}
            </Button>
          </>
        )
      }
    >
      {step === 'members' ? (
        <ContactChecklist
          contacts={contacts}
          selected={picked}
          onChange={setPicked}
          label="Contacts"
          searchLabel="Search contacts for the new group"
          empty="No contacts yet."
        />
      ) : (
        <form
          id="new-group-form"
          className={styles.form}
          onSubmit={(e) => void create(e)}
          noValidate
        >
          <GroupPhotoField
            name={name}
            color={colorForId(name || 'new group')}
            staged={photo}
            onStage={(p) => {
              setPhoto(p);
              setError(null);
            }}
            onProblem={setError}
            disabled={busy}
          />
          <TextInput
            label="Group name (required)"
            value={title}
            autoComplete="off"
            data-autofocus
            disabled={busy}
            aria-required="true"
            trailing={
              graphemes(title).length > GROUP_LIMITS.title / 2 ? (
                <span
                  className={styles.counter}
                  data-warn={
                    graphemes(title).length > (GROUP_LIMITS.title * 3) / 4 ? '' : undefined
                  }
                  aria-hidden
                >
                  {GROUP_LIMITS.title - graphemes(title).length}
                </span>
              ) : null
            }
            onChange={(e) => {
              setTitle(truncateToLimits(e.target.value, 8192, GROUP_LIMITS.title));
              setError(null);
            }}
          />
          <p className={styles.error} role="alert">
            {error}
          </p>
        </form>
      )}
    </Modal>
  );
}
