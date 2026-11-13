import type { SpaceId } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { ConfirmDialog } from '@/ui/primitives';
import { deleteSpace } from './useSpaceMenu';

export function DeleteSpaceDialog({ spaceId, onClose }: { spaceId: SpaceId; onClose: () => void }) {
  const app = useSnowdrop();
  const space = app.stores.spaces.getState().spaces[spaceId];
  if (!space) return null;
  const count = space.categories.reduce((n, c) => n + c.conversationIds.length, 0);
  return (
    // Danger: the safe choice (Cancel) gets focus, so Enter can't delete by accident.
    <ConfirmDialog
      title={`Delete “${space.name}”?`}
      description={
        count > 0
          ? `Its ${count} conversation${count === 1 ? '' : 's'} move back to Home. No messages are deleted and nobody else is affected.`
          : 'The space is empty. Nobody else is affected.'
      }
      confirmLabel="Delete space"
      danger
      run={() => {
        deleteSpace(app, spaceId);
        return Promise.resolve(null);
      }}
      onClose={onClose}
    />
  );
}
