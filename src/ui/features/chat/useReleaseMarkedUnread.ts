import { useEffect, type RefObject } from 'react';
import type { ConversationId } from '@/core/domain';
import { useStores } from '@/ui/hooks';

/** What the reader does in a chat: scroll it, press a key in it, touch it. */
const INTERACTION = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

/**
 * "Mark as unread" on the open chat holds (S8) until the reader interacts with that chat: the
 * first scroll, key (typing included) or press inside it ends the hold. Native listeners on the
 * column itself, so a menu or dialog that opened from it (portals) does not count, and the key
 * that chose "Mark as unread" cannot end what it started.
 */
export function useReleaseMarkedUnread(
  column: RefObject<HTMLElement | null>,
  conversationId: ConversationId | null,
): void {
  const stores = useStores();
  useEffect(() => {
    const el = column.current;
    if (!el || conversationId === null) return undefined;
    const release = () => {
      // Cheap when nothing is marked: the store ignores a no-change update.
      stores.local.getState().setMarkedUnread(conversationId, false);
    };
    for (const type of INTERACTION)
      el.addEventListener(type, release, { capture: true, passive: true });
    return () => {
      for (const type of INTERACTION) el.removeEventListener(type, release, { capture: true });
    };
  }, [column, conversationId, stores]);
}
