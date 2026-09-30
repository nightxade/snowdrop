import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import {
  conversationsSelectors,
  describeTypers,
  isMuted,
  sessionSelectors,
  typingSelectors,
} from '@/core/stores';
import { useNow, useStores } from '@/ui/hooks';
import { previewText, useConversationView } from '@/ui/features/conversation';

/** Everything a sidebar row renders, each piece subscribed separately. */
export function useRowState(id: ConversationId, withPreview: boolean) {
  const stores = useStores();
  const view = useConversationView(id);
  const unread = useStore(stores.conversations, conversationsSelectors.unread(id));
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const typers = useStore(stores.typing, typingSelectors.typers(id));
  const last = useStore(stores.conversations, (s) => (withPreview ? s.lastMessage[id] : undefined));
  const contacts = useStore(stores.contacts, (s) => s.byId);
  // Timed mutes lapse on their own; re-check once a minute.
  const now = useNow(60_000);

  const nameFor = (contactId: string) => contacts[contactId]?.name ?? 'Someone';
  const others = typers.filter((t) => t !== selfId);
  const typing =
    others.length === 0
      ? null
      : view?.kind === 'direct'
        ? 'typing…'
        : describeTypers(others.map((t) => nameFor(t).split(' ')[0] ?? ''));

  return {
    view,
    unread,
    muted: view ? isMuted(view.muted, now) : false,
    typing,
    preview:
      withPreview && view
        ? previewText(last, { selfId, isGroup: view.kind === 'group', nameFor })
        : '',
  };
}
