import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, Message } from '@/core/domain';
import type { Stores } from '@/core/stores';
import { useStores } from '@/ui/hooks';

/**
 * The message a reply is to: the loaded one, else the copy kept when it was last seen (it can
 * leave the window by scrolling far away, with the reply still up). Undefined when there is no
 * reply, or its message was deleted.
 */
export function replyTargetOf(
  stores: Pick<Stores, 'messages' | 'ui'>,
  conversationId: ConversationId,
): Message | undefined {
  const ui = stores.ui.getState();
  const id = ui.replyTo[conversationId];
  if (!id) return undefined;
  const messages = stores.messages.getState();
  if (messages.gone[id]) return undefined;
  const live = messages.windows[conversationId]?.byId[id];
  if (live) return live.deleted ? undefined : live;
  const kept = ui.replySource[conversationId];
  return kept?.id === id ? kept : undefined;
}

/**
 * Keeps a reply honest while the composer is up: remembers its message as it changes, and
 * cancels the reply (the draft stays) once that message is deleted, here or elsewhere.
 */
export function useReplyGuard(conversationId: ConversationId): void {
  const stores = useStores();
  const replyId = useStore(stores.ui, (s) => s.replyTo[conversationId]);
  const live = useStore(stores.messages, (s) =>
    replyId ? s.windows[conversationId]?.byId[replyId] : undefined,
  );
  const gone = useStore(stores.messages, (s) => (replyId ? s.gone[replyId] === true : false));
  useEffect(() => {
    if (!replyId) return;
    const ui = stores.ui.getState();
    if (gone || live?.deleted) ui.setReplyTo(conversationId, null);
    else if (live && ui.replySource[conversationId] !== live)
      ui.setReplyTo(conversationId, replyId, live);
  }, [stores, conversationId, replyId, live, gone]);
}
