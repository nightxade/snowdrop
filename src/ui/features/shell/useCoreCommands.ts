import { useEffect } from 'react';
import { CoreCommand, DEFAULT_KEYBINDS } from '@/core/commands';
import { isMuted, uiSelectors, type Stores } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import {
  currentGlobalOrder,
  currentNavigationOrder,
  stepConversation,
  stepUnread,
  wantsAttention,
} from '@/ui/features/sidebar';

/** Next/previous unread across Home and every space, switching spaces as needed. */
export function jumpToUnread(stores: Stores, delta: 1 | -1): boolean {
  const ui = stores.ui.getState();
  const current = uiSelectors.selectedConversation(ui);
  const unread = stores.conversations.getState().unread;
  const local = stores.local.getState().conversations;
  const spaces = stores.spaces.getState().spaces;
  const now = Date.now();
  const spaceOf = new Map<string, string>();
  for (const space of Object.values(spaces))
    for (const c of space.categories) for (const id of c.conversationIds) spaceOf.set(id, space.id);
  const target = stepUnread(
    currentGlobalOrder(stores),
    current ? { space: ui.selectedSpace, id: current } : null,
    delta,
    (id) => {
      const spaceId = spaceOf.get(id);
      const spaceMuted = spaceId ? (spaces[spaceId]?.muted ?? false) : false;
      const muted = spaceMuted || isMuted(local[id]?.muted ?? false, now);
      return wantsAttention(unread[id], muted);
    },
  );
  if (!target) return false;
  stores.ui.getState().selectConversation(target.id, target.space);
  return true;
}

/** Previous/next row in the visible sidebar. */
export function stepSidebar(stores: Stores, delta: 1 | -1): boolean {
  const ui = stores.ui.getState();
  const current = uiSelectors.selectedConversation(ui);
  const next = stepConversation(currentNavigationOrder(stores), current, delta);
  if (!next || next === current) return false;
  stores.ui.getState().selectConversation(next);
  return true;
}

/**
 * Registers the navigation commands that need view state (PLAN §4.11). The
 * headless ones (switcher, member list, settings, mark read) are registered
 * by the composition root.
 */
export function useCoreCommands(): void {
  const { commands, stores } = useHearth();
  useEffect(() => {
    const disposers = [
      commands.register({
        id: CoreCommand.PrevConversation,
        title: 'Previous conversation',
        category: 'Navigation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.PrevConversation],
        allowInInputs: true,
        run: () => {
          stepSidebar(stores, -1);
        },
      }),
      commands.register({
        id: CoreCommand.NextConversation,
        title: 'Next conversation',
        category: 'Navigation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.NextConversation],
        allowInInputs: true,
        run: () => {
          stepSidebar(stores, 1);
        },
      }),
      commands.register({
        id: CoreCommand.PrevUnread,
        title: 'Previous unread conversation',
        category: 'Navigation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.PrevUnread],
        allowInInputs: true,
        run: () => {
          jumpToUnread(stores, -1);
        },
      }),
      commands.register({
        id: CoreCommand.NextUnread,
        title: 'Next unread conversation',
        category: 'Navigation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.NextUnread],
        allowInInputs: true,
        run: () => {
          jumpToUnread(stores, 1);
        },
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [commands, stores]);
}
