import { useState } from 'react';
import type { SpaceId } from '@/core/stores';
import { useShrike } from '@/ui/hooks';
import { Button, Modal, TextInput } from '@/ui/primitives';

/** Create a category in a space, or rename one (when `categoryId` is given). */
export function CategoryDialog({
  spaceId,
  categoryId,
  onClose,
}: {
  spaceId: SpaceId;
  categoryId?: string | undefined;
  onClose: () => void;
}) {
  const { stores } = useShrike();
  const existing = categoryId
    ? stores.spaces.getState().spaces[spaceId]?.categories.find((c) => c.id === categoryId)
    : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const valid = name.trim().length > 0;
  const save = () => {
    if (!valid) return;
    const s = stores.spaces.getState();
    if (categoryId) s.renameCategory(spaceId, categoryId, name);
    else s.addCategory(spaceId, name);
    onClose();
  };
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={categoryId ? 'Rename category' : 'Create category'}
      {...(categoryId
        ? {}
        : {
            description: 'Categories group conversations inside a space. Drag rows between them.',
          })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            {categoryId ? 'Save' : 'Create category'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextInput
          label="Category name"
          value={name}
          maxLength={40}
          placeholder="e.g. Projects"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </form>
    </Modal>
  );
}
