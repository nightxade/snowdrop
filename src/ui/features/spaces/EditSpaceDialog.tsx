import { useState } from 'react';
import type { SpaceId } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { SpaceForm, type SpaceDraft } from './SpaceForm';

export function EditSpaceDialog({ spaceId, onClose }: { spaceId: SpaceId; onClose: () => void }) {
  const app = useHearth();
  const space = app.stores.spaces.getState().spaces[spaceId];
  const [draft, setDraft] = useState<SpaceDraft>(() => ({
    name: space?.name ?? '',
    emoji: space?.emoji ?? '',
    hue: space?.hue ?? 1,
  }));
  if (!space) return null;
  const valid = draft.name.trim().length > 0;

  const save = () => {
    if (!valid) return;
    app.stores.spaces
      .getState()
      .updateSpace(spaceId, { name: draft.name, hue: draft.hue, emoji: draft.emoji });
    onClose();
  };

  return (
    <Modal
      open
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
      <SpaceForm draft={draft} onChange={setDraft} onSubmit={save} />
    </Modal>
  );
}
