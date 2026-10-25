import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Check,
  Copy,
  FolderInput,
  MessageSquareDot,
  Pin,
  PinOff,
  Rows3,
  Timer,
} from 'lucide-react';
import { useCallback } from 'react';
import { isMuted } from '@/core/stores';
import type { ConversationId } from '@/core/domain';
import { spacesSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';
import {
  archive,
  copyText,
  markRead,
  markUnread,
  MUTE_OPTIONS,
  muteState,
  TIMER_OPTIONS,
  updateConversation,
} from './actions';
import { pluginMenuEntries } from './pluginMenu';

const ICON = 16;

/**
 * Builds the conversation context menu on demand (PLAN §4.3). Reads state at
 * open time rather than subscribing, so a list of rows doesn't re-render for
 * menus nobody opened.
 */
export function useConversationMenu(id: ConversationId): () => MenuEntry[] {
  const app = useSnowdrop();
  return useCallback(() => {
    const { stores, registries } = app;
    const conversation = stores.conversations.getState().byId[id];
    if (!conversation) return [];
    const local = stores.local.getState().conversations[id] ?? {
      pinned: false,
      muted: false,
      archived: false,
    };
    const unread = stores.conversations.getState().unread[id];
    // Like Signal Desktop: one item, whichever applies.
    const isUnread =
      (unread?.count ?? 0) > 0 || (unread?.mentions ?? 0) > 0 || !!local.markedUnread;
    const now = Date.now();
    const muted = isMuted(local.muted, now);
    const spaces = stores.spaces.getState();
    const currentSpace = spacesSelectors.spaceOf(id)(spaces);
    // Keyboard-friendly alternative to dragging rows between categories.
    const categoryMove = (): MenuEntry[] => {
      const space = currentSpace ? spaces.spaces[currentSpace] : undefined;
      if (!space || space.categories.length < 2) return [];
      const here = space.categories.find((c) => c.conversationIds.includes(id))?.id;
      return [
        {
          kind: 'submenu',
          id: 'move-category',
          label: 'Move to category',
          icon: <Rows3 size={ICON} />,
          items: space.categories.map((c): MenuEntry => ({
            kind: 'check',
            id: `cat-${c.id}`,
            label: c.name,
            checked: c.id === here,
            onSelect: () => {
              if (c.id !== here) spaces.moveConversation(id, c.id, c.conversationIds.length);
            },
          })),
        },
      ];
    };
    const orderedSpaces = spacesSelectors.orderedIds(spaces).flatMap((sid) => {
      const space = spaces.spaces[sid];
      return space ? [space] : [];
    });

    const plugin = pluginMenuEntries(
      registries.menus.conversation.list(),
      conversation,
      registries,
    );
    const timer: MenuEntry[] = app.send.capabilities.updateConversation
      ? [
          {
            kind: 'submenu',
            id: 'timer',
            label: 'Disappearing messages',
            icon: <Timer size={ICON} />,
            items: TIMER_OPTIONS.map((option): MenuEntry => ({
              kind: 'check',
              id: `timer-${option.seconds}`,
              label: option.label,
              checked: conversation.expireTimerSec === option.seconds,
              onSelect: () => {
                if (option.seconds !== conversation.expireTimerSec)
                  void updateConversation(app, id, { expireTimerSec: option.seconds });
              },
            })),
          },
        ]
      : [];

    return [
      isUnread
        ? {
            kind: 'item',
            id: 'read',
            label: 'Mark as read',
            icon: <Check size={ICON} />,
            onSelect: () => {
              markRead(app, id);
            },
          }
        : {
            kind: 'item',
            id: 'unread',
            label: 'Mark as unread',
            icon: <MessageSquareDot size={ICON} />,
            onSelect: () => {
              markUnread(app, id);
            },
          },
      { kind: 'separator', id: 's1' },
      muted
        ? {
            kind: 'item',
            id: 'unmute',
            label: 'Unmute',
            icon: <Bell size={ICON} />,
            onSelect: () => {
              stores.local.getState().setMuted(id, false);
            },
          }
        : {
            kind: 'submenu',
            id: 'mute',
            label: 'Mute',
            icon: <BellOff size={ICON} />,
            items: MUTE_OPTIONS.map((option): MenuEntry => ({
              kind: 'item',
              id: `mute-${option.id}`,
              label: option.label,
              onSelect: () => {
                stores.local.getState().setMuted(id, muteState(option.ms, Date.now()));
              },
            })),
          },
      {
        kind: 'item',
        id: 'pin',
        label: local.pinned ? 'Unpin' : 'Pin to top',
        icon: local.pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />,
        onSelect: () => {
          stores.local.getState().setPinned(id, !local.pinned);
        },
      },
      {
        kind: 'submenu',
        id: 'move',
        label: 'Move to space',
        icon: <FolderInput size={ICON} />,
        items: [
          ...orderedSpaces.map((space): MenuEntry => ({
            kind: 'check',
            id: `space-${space.id}`,
            label: `${space.emoji ? `${space.emoji}  ` : ''}${space.name}`,
            checked: space.id === currentSpace,
            onSelect: () => {
              if (space.id === currentSpace) spaces.unassign(id);
              else spaces.assign(id, space.id);
            },
          })),
          ...(orderedSpaces.length > 0 ? [{ kind: 'separator', id: 'move-sep' } as const] : []),
          ...(currentSpace
            ? [
                {
                  kind: 'item',
                  id: 'unassign',
                  label: 'Remove from space',
                  onSelect: () => {
                    spaces.unassign(id);
                  },
                } as const,
              ]
            : []),
          {
            kind: 'item',
            id: 'new-space',
            label: 'New space…',
            onSelect: () => {
              stores.ui
                .getState()
                .openModal({ type: 'createSpace', props: { conversationIds: [id] } });
            },
          },
        ],
      },
      ...categoryMove(),
      ...timer,
      { kind: 'separator', id: 's2' },
      {
        kind: 'item',
        id: 'copy-id',
        label: 'Copy ID',
        icon: <Copy size={ICON} />,
        onSelect: () => {
          void copyText(app, id, 'conversation ID');
        },
      },
      ...(plugin.length > 0 ? [{ kind: 'separator', id: 's-plugins' } as const, ...plugin] : []),
      { kind: 'separator', id: 's3' },
      {
        kind: 'item',
        id: 'archive',
        label: local.archived ? 'Unarchive' : 'Archive',
        icon: local.archived ? <ArchiveRestore size={ICON} /> : <Archive size={ICON} />,
        onSelect: () => {
          archive(app, id, !local.archived);
        },
      },
    ];
  }, [app, id]);
}
