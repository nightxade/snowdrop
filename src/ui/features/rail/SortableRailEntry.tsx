import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { RailEntry } from '@/core/stores';
import { FolderEntry } from './FolderEntry';
import { useMergeTarget } from './RailDragContext';
import { SpaceTile } from './SpaceTile';

/**
 * Pointer-drag reordering of top-level rail entries. Only the pointer
 * listeners are attached (not dnd-kit's keyboard attributes) so Enter/Space
 * keep activating the tile and our roving tabindex stays intact; keyboard
 * users reorder via the tile's context menu (Move up / Move down) and file
 * spaces into folders with "Add to folder".
 */
export function SortableRailEntry({ id, entry }: { id: string; entry: RailEntry }) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({ id });
  const merge = useMergeTarget() === id;
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  if (entry.type === 'folder') {
    return (
      <FolderEntry
        folder={entry}
        wrapperRef={setNodeRef}
        wrapperStyle={style}
        dragHandle={listeners}
        dragging={isDragging}
        mergeTarget={merge}
      />
    );
  }
  return (
    <SpaceTile
      spaceId={entry.id}
      wrapperRef={setNodeRef}
      wrapperStyle={style}
      dragging={isDragging}
      mergeTarget={merge}
      {...listeners}
    />
  );
}
