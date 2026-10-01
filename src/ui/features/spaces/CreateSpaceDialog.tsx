import { useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { useShrike } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { SpaceForm, type SpaceDraft } from './SpaceForm';

/**
 * Create a space. P2 covers name/icon/colour; P4 adds the searchable group
 * checklist with shared-member suggestions (PLAN §4.2).
 */
export function CreateSpaceDialog({
  conversationIds = [],
  onClose,
}: {
  conversationIds?: readonly ConversationId[];
  onClose: () => void;
}) {
  const app = useShrike();
  const [draft, setDraft] = useState<SpaceDraft>(() => ({
    name: '',
    emoji: '',
    hue: (Object.keys(app.stores.spaces.getState().spaces).length % 12) + 1,
  }));
  const valid = draft.name.trim().length > 0;

  const create = () => {
    if (!valid) return;
    const id = app.stores.spaces.getState().createSpace({
      name: draft.name,
      hue: draft.hue,
      conversationIds,
      ...(draft.emoji ? { emoji: draft.emoji } : {}),
    });
    const [first] = conversationIds;
    if (first) app.stores.ui.getState().selectConversation(first, id);
    else app.stores.ui.getState().selectSpace(id);
    onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Create a space"
      description="Spaces gather related Signal groups in one place. They live on this device only; nobody else sees them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={create}>
            Create space
          </Button>
        </>
      }
    >
      <SpaceForm draft={draft} onChange={setDraft} onSubmit={create} />
    </Modal>
  );
}
