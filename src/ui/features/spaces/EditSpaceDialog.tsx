import { useState } from 'react';
import type { SpaceId } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import type { ConversationId } from '@/core/domain';
import { ConversationChecklist } from './ConversationChecklist';
import { SpaceForm, type SpaceDraft } from './SpaceForm';

export function EditSpaceDialog({ spaceId, onClose }: { spaceId: SpaceId; onClose: () => void }) {
  const app = useSnowdrop();
  const space = app.stores.spaces.getState().spaces[spaceId];
  const [draft, setDraft] = useState<SpaceDraft>(() => ({
    name: space?.name ?? '',
    emoji: space?.emoji ?? '',
    hue: space?.hue ?? 1,
  }));
  const [original] = useState<ReadonlySet<ConversationId>>(
    () => new Set(space?.categories.flatMap((c) => c.conversationIds) ?? []),
  );
  const [picked, setPicked] = useState<Set<ConversationId>>(() => new Set(original));
  if (!space) return null;
  const valid = draft.name.trim().length > 0;

  const save = () => {
    if (!valid) return;
    const store = app.stores.spaces.getState();
    store.updateSpace(spaceId, { name: draft.name, hue: draft.hue, emoji: draft.emoji });
    // Membership: removed ones go back to Home, new ones join the first category.
    for (const id of original) if (!picked.has(id)) store.unassign(id);
    for (const id of picked) if (!original.has(id)) store.assign(id, spaceId);
    onClose();
  };

  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit space"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <SpaceForm draft={draft} onChange={setDraft} onSubmit={save}>
        <ConversationChecklist selected={picked} onChange={setPicked} spaceId={spaceId} />
      </SpaceForm>
    </Modal>
  );
}
