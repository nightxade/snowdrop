import type { SpaceId } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { deleteSpace } from './useSpaceMenu';

export function DeleteSpaceDialog({ spaceId, onClose }: { spaceId: SpaceId; onClose: () => void }) {
  const app = useHearth();
  const space = app.stores.spaces.getState().spaces[spaceId];
  if (!space) return null;
  const count = space.categories.reduce((n, c) => n + c.conversationIds.length, 0);
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete “${space.name}”?`}
      description={
        count > 0
          ? `Its ${count} conversation${count === 1 ? '' : 's'} move back to Home. No messages are deleted and nobody else is affected.`
          : 'The space is empty. Nobody else is affected.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            autoFocus
            onClick={() => {
              deleteSpace(app, spaceId);
              onClose();
            }}
          >
            Delete space
          </Button>
        </>
      }
    />
  );
}
