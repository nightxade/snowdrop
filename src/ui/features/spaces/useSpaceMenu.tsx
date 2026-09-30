import { ArrowDown, ArrowUp, BellOff, Check, Pencil, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { HOME, type SpaceId } from '@/core/stores';
import { useHearth, type AppServices } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';

const ICON = 16;

export function spaceConversationIds(app: AppServices, spaceId: SpaceId) {
  const space = app.stores.spaces.getState().spaces[spaceId];
  return space ? space.categories.flatMap((c) => c.conversationIds) : [];
}

export function markSpaceRead(app: AppServices, spaceId: SpaceId): void {
  const unread = app.stores.conversations.getState().unread;
  for (const id of spaceConversationIds(app, spaceId)) {
    if ((unread[id]?.count ?? 0) > 0) void app.sync.markConversationRead(id);
  }
}

/** Space context/dropdown menu (PLAN §4.2): mark read, mute, edit, delete + plugin items. */
export function useSpaceMenu(spaceId: SpaceId): () => MenuEntry[] {
  const app = useHearth();
  return useCallback(() => {
    const { stores, registries } = app;
    const space = stores.spaces.getState().spaces[spaceId];
    if (!space) return [];
    const unread = stores.conversations.getState().unread;
    const hasUnread = space.categories.some((c) =>
      c.conversationIds.some((id) => (unread[id]?.count ?? 0) > 0),
    );
    const plugin = registries.menus.space
      .list()
      .filter((item) => {
        try {
          return item.visible?.({ spaceId }) ?? true;
        } catch {
          return false;
        }
      })
      .map((item): MenuEntry => ({
        kind: 'item',
        id: `plugin:${item.owner}:${item.id}`,
        label: item.label,
        ...(item.danger ? { danger: true } : {}),
        onSelect: () => {
          try {
            item.onSelect({ spaceId });
          } catch (error) {
            console.error(`[hearth] plugin "${item.owner}" menu item failed`, error);
          }
        },
      }));
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
      ...move,
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

/** Deleting returns the space's conversations to Home; leave the view if it was open. */
export function deleteSpace(app: AppServices, spaceId: SpaceId): void {
  const ui = app.stores.ui.getState();
  if (ui.selectedSpace === spaceId) ui.selectSpace(HOME);
  app.stores.spaces.getState().deleteSpace(spaceId);
}
