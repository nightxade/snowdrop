import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import {
  conversationsSelectors,
  describeTypers,
  isMuted,
  sessionSelectors,
  typingSelectors,
  type ContactsState,
} from '@/core/stores';
import { useFrozenWhile, useNow, useStores } from '@/ui/hooks';
import { previewText, useConversationView } from '@/ui/features/conversation';

const nameIn = (s: ContactsState) => (contactId: string) => s.byId[contactId]?.name ?? 'Someone';

/** Shown instead of the real preview while catching up (see `useRowState`). */
export const CATCHING_UP_PREVIEW = 'Loading…';

/**
 * Everything a sidebar row renders. Derived strings (preview, typing line)
 * are computed inside the selectors, so a row re-renders only when the text
 * it shows changes, not whenever any contact changes.
 */
export function useRowState(id: ConversationId, withPreview: boolean) {
  const stores = useStores();
  const view = useConversationView(id);
  const catchingUp = useStore(stores.session, sessionSelectors.catchingUp);
  const liveUnread = useStore(stores.conversations, conversationsSelectors.unread(id));
  // Badge counts hold at their pre-catch-up value, same as the sidebar's order.
  const unread = useFrozenWhile(liveUnread, catchingUp);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const typers = useStore(stores.typing, typingSelectors.typers(id));
  const last = useStore(stores.conversations, (s) => (withPreview ? s.lastMessage[id] : undefined));
  const isGroup = view?.kind === 'group';
  const livePreview = useStore(stores.contacts, (s) =>
    withPreview ? previewText(last, { selfId, isGroup, nameFor: nameIn(s) }) : '',
  );
  const typing = useStore(stores.contacts, (s) => {
    const others = typers.filter((t) => t !== selfId);
    if (others.length === 0) return null;
    if (!isGroup) return 'typing…';
    return describeTypers(others.map((t) => nameIn(s)(t).split(' ')[0] ?? ''));
  });
  const preview = withPreview && catchingUp ? CATCHING_UP_PREVIEW : livePreview;
  // Timed mutes lapse on their own; the shared minute clock re-checks them.
  const now = useNow(60_000);

  return {
    view,
    unread,
    muted: view ? isMuted(view.muted, now) : false,
    typing,
    preview,
    catchingUp,
  };
}
