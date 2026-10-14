/**
 * Core's own contributions to the TUI shell's status line (`status.items`,
 * src/ui/features/shell/StatusLine.tsx): the open conversation, total unread
 * and connection state. Registered directly (owner `'core'`) rather than
 * through a `PluginContext`, since core isn't a plugin — the slot doesn't
 * care, which is exactly how the Vim Mode plugin's NORMAL/INSERT item ends
 * up beside these without core knowing Vim exists.
 */
import type { Disposer } from '@/core/lib';
import type { Registries } from '@/core/plugins';
import type { Stores } from '@/core/stores';
import {
  makeConnectionStatusItem,
  makeConversationStatusItem,
  makeUnreadStatusItem,
} from '@/ui/features/shell';

export function registerCoreStatusItems(registries: Registries, stores: Stores): Disposer[] {
  return [
    registries.statusItems.add({
      id: 'conversation',
      owner: 'core',
      component: makeConversationStatusItem(stores),
    }),
    registries.statusItems.add({
      id: 'unread',
      owner: 'core',
      component: makeUnreadStatusItem(stores),
    }),
    registries.statusItems.add({
      id: 'connection',
      owner: 'core',
      component: makeConnectionStatusItem(stores),
    }),
  ];
}
