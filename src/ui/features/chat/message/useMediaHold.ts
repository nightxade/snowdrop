import { useCallback, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useMessageRequestState } from '@/ui/features/conversation';
import { useStores } from '@/ui/hooks';

/**
 * Media someone sends is not fetched, decoded or shown until the user lets
 * it: automatically once they accept the conversation (Signal Desktop does
 * the same for message requests), or one attachment at a time, on a
 * deliberate "Download" before that. This remembers those per-item choices
 * for the session (a list scrolling a row out and back in must not hide it
 * again); it never outlives the app, so a restart asks again.
 */
const released = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forgets every per-item release. */
export function resetReleasedMedia(): void {
  released.clear();
  for (const listener of listeners) listener();
}

const keyOf = (conversationId: ConversationId, itemId: string): string =>
  `${conversationId}\u0000${itemId}`;

/**
 * Whether another person's media in this conversation is being held back
 * (the conversation is a message request or blocked). Your own messages'
 * media never is, and neither is media with no author (the user's own
 * sticker picker).
 */
export function useIncomingMediaHeld(
  conversationId: ConversationId,
  authorId: string | undefined,
): boolean {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const state = useMessageRequestState(conversationId);
  return state !== 'accepted' && authorId !== undefined && authorId !== selfId;
}

/** `useIncomingMediaHeld`, minus what the user already chose to download. */
export function useMediaHold(
  conversationId: ConversationId,
  authorId: string | undefined,
  itemId: string,
): { held: boolean; release: () => void } {
  const heldByConversation = useIncomingMediaHeld(conversationId, authorId);
  const key = keyOf(conversationId, itemId);
  const chosen = useSyncExternalStore(subscribe, () => released.has(key));
  const release = useCallback(() => {
    released.add(key);
    for (const listener of listeners) listener();
  }, [key]);
  return { held: heldByConversation && !chosen, release };
}
