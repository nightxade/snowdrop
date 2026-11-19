import {
  ArrowDown,
  ArrowUp,
  BellOff,
  Check,
  FolderMinus,
  FolderPlus,
  ListPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useCallback } from 'react';
import { HOME, uiSelectors, unreadConversationIds, type SpaceId } from '@/core/stores';
import { useSnowdrop, type AppServices } from '@/ui/hooks';
import { pluginMenuEntries } from '@/ui/features/conversation';
import type { MenuEntry } from '@/ui/primitives';

const ICON = 16;

export function spaceConversationIds(app: AppServices, spaceId: SpaceId) {
  const space = app.stores.spaces.getState().spaces[spaceId];
  return space ? space.categories.flatMap((c) => c.conversationIds) : [];
}

/**
 * The chats of a space with something unread. `counted` leaves out archived
 * ones, which is what decides whether "Mark all as read" is offered (as in
 * Signal Desktop); marking itself also clears archived chats, as there.
 */
export function unreadInSpace(app: AppServices, spaceId: SpaceId, counted = true) {
  return unreadConversationIds(
    app.stores.conversations.getState().unread,
    app.stores.local.getState().conversations,
    spaceConversationIds(app, spaceId),
    { includeArchived: !counted },
  );
}

export function markSpaceRead(app: AppServices, spaceId: SpaceId): void {
  const ids = unreadInSpace(app, spaceId, false);
  // The user's own action: badges held for a catch-up clear at once (S1).
  app.stores.session.getState().releaseHeld(ids);
  for (const id of ids) void app.sync.markConversationRead(id);
}

/** Space context/dropdown menu (PLAN §4.2): mark read, mute, edit, delete + plugin items. */
export function useSpaceMenu(spaceId: SpaceId): () => MenuEntry[] {
  const app = useSnowdrop();
  return useCallback(() => {
    const { stores, registries } = app;
    const space = stores.spaces.getState().spaces[spaceId];
    if (!space) return [];
    const hasUnread = unreadInSpace(app, spaceId).length > 0;
    const plugin = pluginMenuEntries(registries.menus.space.list(), { spaceId }, registries);
    // Keyboard-accessible reordering (drag & drop is pointer-only).
    const rail = stores.spaces.getState().rail;
    const index = rail.findIndex((e) => e.type === 'space' && e.id === spaceId);
    const move: MenuEntry[] =
      index === -1
        ? []
        : [
            { kind: 'separator', id: 's-move' },
            {
              kind: 'item',
              id: 'move-up',
              label: 'Move up',
              icon: <ArrowUp size={ICON} />,
              disabled: index === 0,
              onSelect: () => {
                stores.spaces.getState().moveRailEntry(index, index - 1);
              },
            },
            {
              kind: 'item',
              id: 'move-down',
              label: 'Move down',
              icon: <ArrowDown size={ICON} />,
              disabled: index === rail.length - 1,
              onSelect: () => {
                stores.spaces.getState().moveRailEntry(index, index + 1);
              },
            },
          ];
    // Folders without drag: join an existing folder, start one with another space, or leave.
    const spaceNames = stores.spaces.getState().spaces;
    const inFolder = rail.find((e) => e.type === 'folder' && e.spaceIds.includes(spaceId));
    const folderTargets: MenuEntry[] = [
      ...rail.flatMap((e): MenuEntry[] =>
        e.type === 'folder' && e !== inFolder
          ? [
              {
                kind: 'item',
                id: `folder-${e.id}`,
                label: e.name,
                onSelect: () => {
                  const first = e.spaceIds[0];
                  if (first) stores.spaces.getState().createFolder(first, spaceId);
                },
              },
            ]
          : [],
      ),
      ...rail.flatMap((e): MenuEntry[] => {
        if (e.type !== 'space' || e.id === spaceId) return [];
        const other = spaceNames[e.id];
        return other
          ? [
              {
                kind: 'item',
                id: `with-${e.id}`,
                label: `New folder with ${other.name}`,
                onSelect: () => {
                  stores.spaces.getState().createFolder(e.id, spaceId);
                },
              },
            ]
          : [];
      }),
    ];
    const folders: MenuEntry[] = [
      ...(folderTargets.length > 0
        ? [
            {
              kind: 'submenu',
              id: 'add-folder',
              label: 'Add to folder',
              icon: <FolderPlus size={ICON} />,
              items: folderTargets,
            } as const,
          ]
        : []),
      ...(inFolder
        ? [
            {
              kind: 'item',
              id: 'leave-folder',
              label: 'Remove from folder',
              icon: <FolderMinus size={ICON} />,
              onSelect: () => {
                stores.spaces.getState().removeFromFolder(spaceId);
              },
            } as const,
          ]
        : []),
    ];
    return [
      {
        kind: 'item',
        id: 'read',
        label: 'Mark all as read',
        icon: <Check size={ICON} />,
        disabled: !hasUnread,
        onSelect: () => {
          markSpaceRead(app, spaceId);
        },
      },
      { kind: 'separator', id: 's1' },
      {
        kind: 'check',
        id: 'mute',
        label: 'Mute space',
        icon: <BellOff size={ICON} />,
        checked: space.muted,
        onSelect: () => {
          stores.spaces.getState().updateSpace(spaceId, { muted: !space.muted });
        },
      },
      {
        kind: 'item',
        id: 'edit',
        label: 'Edit space',
        icon: <Pencil size={ICON} />,
        onSelect: () => {
          stores.ui.getState().openModal({ type: 'editSpace', props: { spaceId } });
        },
      },
      {
        kind: 'item',
        id: 'add-category',
        label: 'Create category',
        icon: <ListPlus size={ICON} />,
        onSelect: () => {
          stores.ui.getState().openModal({ type: 'category', props: { spaceId } });
        },
      },
      ...move,
      ...folders,
      ...(plugin.length > 0 ? [{ kind: 'separator', id: 's-plugins' } as const, ...plugin] : []),
      { kind: 'separator', id: 's2' },
      {
        kind: 'item',
        id: 'delete',
        label: 'Delete space',
        icon: <Trash2 size={ICON} />,
        danger: true,
        onSelect: () => {
          stores.ui.getState().openModal({ type: 'deleteSpace', props: { spaceId } });
        },
      },
    ];
  }, [app, spaceId]);
}

/**
 * Deleting returns the space's conversations to Home; leave the view if it was open, with the
 * chat that was open there still open, now in Home.
 */
export function deleteSpace(app: AppServices, spaceId: SpaceId): void {
  const ui = app.stores.ui.getState();
  if (ui.selectedSpace === spaceId) {
    const open = uiSelectors.selectedConversation(ui);
    if (open) ui.selectConversation(open, HOME);
    else ui.selectSpace(HOME);
  }
  app.stores.spaces.getState().deleteSpace(spaceId);
}
