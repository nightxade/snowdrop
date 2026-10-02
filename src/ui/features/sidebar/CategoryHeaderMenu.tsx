import { ArrowDown, ArrowUp, ListPlus, Pencil, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { useStores } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';

const ICON = 16;

/** Category menu: rename, add, reorder, delete (its rows move to the first category). */
export function useCategoryMenu(spaceId: string, categoryId: string): () => MenuEntry[] {
  const stores = useStores();
  return useCallback(() => {
    const space = stores.spaces.getState().spaces[spaceId];
    if (!space) return [];
    const index = space.categories.findIndex((c) => c.id === categoryId);
    const category = space.categories[index];
    if (!category) return [];
    const open = (props: Record<string, unknown>) => {
      stores.ui.getState().openModal({ type: 'category', props: { spaceId, ...props } });
    };
    return [
      {
        kind: 'item',
        id: 'rename',
        label: 'Rename category',
        icon: <Pencil size={ICON} />,
        onSelect: () => {
          open({ categoryId });
        },
      },
      {
        kind: 'item',
        id: 'add',
        label: 'Create category',
        icon: <ListPlus size={ICON} />,
        onSelect: () => {
          open({});
        },
      },
      { kind: 'separator', id: 's1' },
      {
        kind: 'item',
        id: 'up',
        label: 'Move up',
        icon: <ArrowUp size={ICON} />,
        disabled: index === 0,
        onSelect: () => {
          stores.spaces.getState().moveCategory(spaceId, categoryId, index - 1);
        },
      },
      {
        kind: 'item',
        id: 'down',
        label: 'Move down',
        icon: <ArrowDown size={ICON} />,
        disabled: index === space.categories.length - 1,
        onSelect: () => {
          stores.spaces.getState().moveCategory(spaceId, categoryId, index + 1);
        },
      },
      { kind: 'separator', id: 's2' },
      {
        kind: 'item',
        id: 'delete',
        label: 'Delete category',
        icon: <Trash2 size={ICON} />,
        danger: true,
        disabled: space.categories.length <= 1,
        onSelect: () => {
          const moved = category.conversationIds.length;
          stores.spaces.getState().removeCategory(spaceId, categoryId);
          const first = stores.spaces.getState().spaces[spaceId]?.categories[0];
          stores.ui.getState().pushToast({
            message:
              moved > 0 && first
                ? `Deleted “${category.name}”; its ${moved} conversation${moved === 1 ? '' : 's'} moved to ${first.name}`
                : `Deleted “${category.name}”`,
            kind: 'info',
            source: 'core',
          });
        },
      },
    ];
  }, [stores, spaceId, categoryId]);
}
