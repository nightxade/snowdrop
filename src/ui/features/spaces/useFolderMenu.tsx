import { Check, ChevronsDownUp, ChevronsUpDown, FolderMinus, Pencil } from 'lucide-react';
import { useCallback } from 'react';
import { useSnowdrop } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';
import { markSpaceRead } from './useSpaceMenu';

const ICON = 16;

/** Folder tile menu: mark read, expand/collapse, edit (name + colour), dissolve. */
export function useFolderMenu(folderId: string): () => MenuEntry[] {
  const app = useSnowdrop();
  return useCallback(() => {
    const { stores } = app;
    const folder = stores.spaces
      .getState()
      .rail.find((e) => e.type === 'folder' && e.id === folderId);
    if (folder?.type !== 'folder') return [];
    const unread = stores.conversations.getState().unread;
    const local = stores.local.getState().conversations;
    const spaces = stores.spaces.getState().spaces;
    const hasUnread = folder.spaceIds.some((sid) =>
      spaces[sid]?.categories.some((c) =>
        c.conversationIds.some(
          (id) => (unread[id]?.count ?? 0) > 0 || local[id]?.markedUnread === true,
        ),
      ),
    );
    return [
      {
        kind: 'item',
        id: 'read',
        label: 'Mark all as read',
        icon: <Check size={ICON} />,
        disabled: !hasUnread,
        onSelect: () => {
          for (const sid of folder.spaceIds) markSpaceRead(app, sid);
        },
      },
      {
        kind: 'item',
        id: 'toggle',
        label: folder.collapsed ? 'Expand folder' : 'Collapse folder',
        icon: folder.collapsed ? <ChevronsUpDown size={ICON} /> : <ChevronsDownUp size={ICON} />,
        onSelect: () => {
          stores.spaces.getState().toggleFolder(folderId);
        },
      },
      { kind: 'separator', id: 's1' },
      {
        kind: 'item',
        id: 'edit',
        label: 'Rename and recolour…',
        icon: <Pencil size={ICON} />,
        onSelect: () => {
          stores.ui.getState().openModal({ type: 'editFolder', props: { folderId } });
        },
      },
      {
        kind: 'item',
        id: 'dissolve',
        label: 'Dissolve folder',
        icon: <FolderMinus size={ICON} />,
        onSelect: () => {
          stores.spaces.getState().dissolveFolder(folderId);
          stores.ui.getState().pushToast({
            message: `“${folder.name}” dissolved; its spaces are back on the rail`,
            kind: 'info',
            source: 'core',
          });
        },
      },
    ];
  }, [app, folderId]);
}
