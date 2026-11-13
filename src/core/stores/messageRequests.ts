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
 *
 * The stamp is the time the message was sent (the earliest one per
 * conversation), not the time it is processed here: a block or delete the
 * user made on the phone after that message is replayed later with its own
 * (earlier than now) time, and must still count as newer than the accept.
 */
export function acceptForOutgoing(
  stores: Pick<Stores, 'local' | 'session'>,
  messages: readonly Message[],
): void {
  const selfId = stores.session.getState().self?.id;
  if (!selfId) return;
  const local = stores.local.getState();
  const earliest = new Map<ConversationId, number>();
  for (const m of messages) {
    if (m.authorId !== selfId || m.kind !== 'normal') continue;
    if (local.acceptedChats[m.conversationId] !== undefined) continue;
    const seen = earliest.get(m.conversationId);
    if (seen === undefined || m.sentAt < seen) earliest.set(m.conversationId, m.sentAt);
  }
  for (const [id, sentAt] of earliest) local.markAccepted(id, sentAt);
}

/**
 * Whether the user deleted this message request and the other side hasn't
 * written since (`localStore.deletedChats`). While it holds, nothing may
 * write the conversation's messages back into the repository: not a history
 * page, not the phone's archive import, not a backfill.
 */
export function isDeletedRequest(stores: Pick<Stores, 'local'>, id: ConversationId): boolean {
  return stores.local.getState().deletedChats[id] !== undefined;
}
