/**
 * The TUI shell status line's core items (`status.items`, owner `'core'`):
 * the open conversation, total unread and connection state. Registered
 * directly by the composition root (`src/app/statusItems.tsx`) — core isn't
 * a plugin, but the slot doesn't care who contributes to it, which is how
 * the Vim Mode plugin's NORMAL/INSERT item sits beside these without core
 * knowing it exists.
 */
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ConversationId } from '@/core/domain';
import { sessionSelectors, totalUnread, uiSelectors, type Stores } from '@/core/stores';
import { useNow } from '@/ui/hooks';
import styles from './CoreStatusItems.module.css';

const CONNECTION_LABEL: Record<string, string> = {
  online: 'online',
  connecting: 'connecting…',
  offline: 'offline',
  error: 'connection error',
};

export function makeConversationStatusItem(stores: Stores) {
  return function ConversationStatusItem() {
    const selected = useStore(stores.ui, uiSelectors.selectedConversation);
    const title = useStore(stores.conversations, (s) =>
      selected ? s.byId[selected]?.title : undefined,
    );
    return <span className={styles.item}>{title ?? 'no conversation'}</span>;
  };
}

export function makeUnreadStatusItem(stores: Stores) {
  return function UnreadStatusItem() {
    const now = useNow(60_000);
    const local = useStore(stores.local, (s) => s.conversations);
    const count = useStore(
      stores.conversations,
      useShallow(
        (s) => totalUnread(s.unread, local, Object.keys(s.byId) as ConversationId[], now).count,
      ),
    );
    return <span className={styles.item}>{count} unread</span>;
  };
}

export function makeConnectionStatusItem(stores: Stores) {
  return function ConnectionStatusItem() {
    const status = useStore(stores.session, sessionSelectors.status);
    return <span className={styles.item}>{CONNECTION_LABEL[status] ?? status}</span>;
  };
}
