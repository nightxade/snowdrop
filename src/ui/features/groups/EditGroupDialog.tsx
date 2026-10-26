import { useState, type SubmitEvent } from 'react';
import {
  GROUP_LIMITS,
  normalizeGroupDescription,
  normalizeGroupTitle,
  type ConversationId,
} from '@/core/domain';
import type { GroupChange } from '@/core/backend';
import { graphemes, truncateToLimits } from '@/core/lib';
import { colorForId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, TextInput } from '@/ui/primitives';
import { GroupPhotoField, type StagedPhoto } from './GroupPhotoField';
import { useGroup } from './useGroup';
import styles from './groups.module.css';

const BYTES = 8192;

function Counter({ text, max }: { text: string; max: number }) {
  const remaining = max - graphemes(text).length;
  if (remaining > max / 2) return null;
  return (
    <span className={styles.counter} data-warn={remaining <= max / 4 ? '' : undefined} aria-hidden>
      {remaining}
    </span>
  );
}

/** Edit a group's name, description and photo, for everyone in it (Desktop's "Edit group"). */
export function EditGroupDialog({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, canEdit } = useGroup(conversationId);
  const [title, setTitle] = useState(group?.title ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [photo, setPhoto] = useState<StagedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!group) return null;

  const name = normalizeGroupTitle(title);
  const about = normalizeGroupDescription(description);
  const change: GroupChange = {
    ...(name !== group.title ? { title: name } : {}),
    ...(about !== (group.description ?? '') ? { description: about } : {}),
    ...(photo ? { avatar: photo.dataUri } : {}),
  };
  const dirty = Object.keys(change).length > 0;
  const valid = name !== '' && canEdit;

  const save = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !dirty || !valid) return;
    setBusy(true);
    setError(null);
    const failure = await app.groups.update(conversationId, change);
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <Modal
      open
      size="md"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Edit group"
      description="Changes are visible to everyone in the group."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="edit-group-form"
            disabled={busy || !dirty || !valid}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="edit-group-form" className={styles.form} onSubmit={(e) => void save(e)} noValidate>
        <GroupPhotoField
          name={name || group.title}
          color={colorForId(group.id)}
          groupId={group.id}
          avatarVersion={group.avatarVersion}
          current={group.avatarUrl}
          staged={photo}
          onStage={(p) => {
            setPhoto(p);
            setError(null);
          }}
          onProblem={setError}
          disabled={busy}
        />
        <TextInput
          label="Group name"
          value={title}
          autoComplete="off"
          data-autofocus
          disabled={busy}
          aria-required="true"
          trailing={<Counter text={title} max={GROUP_LIMITS.title} />}
          onChange={(e) => {
            setTitle(truncateToLimits(e.target.value, BYTES, GROUP_LIMITS.title));
            setError(null);
          }}
        />
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="edit-group-about">
            Description
          </label>
          <textarea
            id="edit-group-about"
            className={styles.textarea}
            rows={4}
            value={description}
            disabled={busy}
            aria-describedby="edit-group-about-note"
            onChange={(e) => {
              setDescription(truncateToLimits(e.target.value, BYTES, GROUP_LIMITS.description));
              setError(null);
            }}
          />
          <p id="edit-group-about-note" className={styles.note}>
            Visible to members of this group and people who have been invited.
            <Counter text={description} max={GROUP_LIMITS.description} />
          </p>
        </div>
        <p className={styles.error} role="alert">
          {error}
        </p>
      </form>
    </Modal>
  );
}
