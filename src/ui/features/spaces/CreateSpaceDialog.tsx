import { useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { ConversationChecklist } from './ConversationChecklist';
import { SpaceForm, type SpaceDraft } from './SpaceForm';

/**
 * Create a space: name, icon, colour and a searchable checklist of groups and
 * DMs, with suggestions that share members with what's picked (PLAN §4.2).
 */
export function CreateSpaceDialog({
  conversationIds = [],
  onClose,
}: {
  conversationIds?: readonly ConversationId[];
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const [draft, setDraft] = useState<SpaceDraft>(() => ({
    name: '',
    emoji: '',
    hue: (Object.keys(app.stores.spaces.getState().spaces).length % 12) + 1,
  }));
  const [picked, setPicked] = useState<Set<ConversationId>>(() => new Set(conversationIds));
  const valid = draft.name.trim().length > 0;

  const create = () => {
    if (!valid) return;
    const id = app.stores.spaces.getState().createSpace({
      name: draft.name,
      hue: draft.hue,
      conversationIds: [...picked],
      ...(draft.emoji ? { emoji: draft.emoji } : {}),
    });
    const [first] = picked;
    if (first) app.stores.ui.getState().selectConversation(first, id);
    else app.stores.ui.getState().selectSpace(id);
    onClose();
  };

  return (
    <Modal
      open
      size="lg"
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
            {picked.size > 0 ? `Create with ${picked.size}` : 'Create space'}
          </Button>
        </>
      }
    >
      <SpaceForm draft={draft} onChange={setDraft} onSubmit={create}>
        <ConversationChecklist selected={picked} onChange={setPicked} />
      </SpaceForm>
    </Modal>
  );
}
