import { useCallback, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { isTrustedContact, type ConversationId } from '@/core/domain';
import { contactsSelectors, sessionSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { useMessageRequestState } from './useConversation';

/**
 * A stranger's picture is not fetched or shown until the user lets it, the
 * way Signal Desktop treats a message request: automatically once they
 * accept the conversation, or for one person on a deliberate "View" before
 * that. The per-person choice is remembered for the session only (a row
 * scrolling out and back must not hide it again); a restart asks again.
 */
const revealed = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forgets every per-person choice. */
export function resetRevealedAvatars(): void {
  revealed.clear();
  for (const listener of listeners) listener();
}

/**
 * Whether this person's picture is being held back. It never is for the
 * user, for a saved contact or someone sharing profiles with the user, or
 * inside a conversation the user accepted (`conversationId`, where it is the
 * one the avatar sits in: a stranger in an accepted group shows, like their
 * media does). `reveal` shows it for the rest of the session.
 */
export function usePersonAvatarHold(
  contactId: string | undefined,
  conversationId: ConversationId | undefined,
): { held: boolean; reveal: () => void } {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const trusted = useStore(
    stores.contacts,
    (s) =>
      contactId !== undefined &&
      (contactId === selfId || isTrustedContact(contactsSelectors.contact(contactId)(s))),
  );
  const requestState = useMessageRequestState(conversationId ?? null);
  const chosen = useSyncExternalStore(subscribe, () =>
    contactId === undefined ? false : revealed.has(contactId),
  );
  const reveal = useCallback(() => {
    if (contactId === undefined) return;
    revealed.add(contactId);
    for (const listener of listeners) listener();
  }, [contactId]);
  const accepted = conversationId !== undefined && requestState === 'accepted';
  return { held: !(trusted || accepted || chosen), reveal };
}

/** Whether a group's picture is being held back: the group is a message request or blocked. */
export function useGroupAvatarHold(conversationId: ConversationId): boolean {
  return useMessageRequestState(conversationId) !== 'accepted';
}
