/**
 * Reads a conversation's message-request state across the stores that hold
 * the facts for it (see core/domain/messageRequests for the rules). The
 * `useMessageRequestState` hook in the UI does the same reading reactively.
 */
import {
  messageRequestState,
  type Message,
  type ConversationId,
  type MessageRequestFacts,
  type MessageRequestState,
} from '@/core/domain';
import type { Stores } from './index';

export function messageRequestFacts(
  stores: Pick<Stores, 'contacts' | 'local' | 'session'>,
  id: ConversationId,
): MessageRequestFacts {
  const contacts = stores.contacts.getState().byId;
  return {
    selfId: stores.session.getState().self?.id ?? null,
    contact: (contactId) => contacts[contactId],
    acceptedHere: stores.local.getState().acceptedChats[id] !== undefined,
  };
}

/**
 * `accepted` for a conversation the stores don't know: nothing about an
 * unknown one is withheld (there is nothing of it on screen to protect).
 */
export function selectMessageRequestState(
  stores: Pick<Stores, 'contacts' | 'conversations' | 'local' | 'session'>,
  id: ConversationId,
): MessageRequestState {
  const conversation = stores.conversations.getState().byId[id];
  return conversation
    ? messageRequestState(conversation, messageRequestFacts(stores, id))
    : 'accepted';
}

/**
 * Desktop counts a conversation as accepted once it has any outgoing message
 * (`sentMessageCount > 0`), wherever it was sent from: here, on the user's
 * phone (a sync transcript), or earlier (history pages, the phone's archive).
 * Marks every conversation in `messages` that has a real message from the
 * user. Never un-accepts anything.
 */
export function acceptForOutgoing(
  stores: Pick<Stores, 'local' | 'session'>,
  messages: readonly Message[],
  at: number,
): void {
  const selfId = stores.session.getState().self?.id;
  if (!selfId) return;
  const local = stores.local.getState();
  for (const m of messages) {
    if (
      m.authorId === selfId &&
      m.kind === 'normal' &&
      local.acceptedChats[m.conversationId] === undefined
    )
      local.markAccepted(m.conversationId, at);
  }
}
