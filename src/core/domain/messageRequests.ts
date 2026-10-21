/**
 * Message requests: a conversation from someone (or a group from someone)
 * the user hasn't accepted yet. The rules follow Signal Desktop's
 * `isConversationAccepted`, as far as what signal-cli tells us allows:
 *
 * - the user's own note-to-self is always accepted;
 * - a direct chat is accepted when the peer is a trusted contact: saved on
 *   the phone (`inContacts`) or someone the user has chatted with or accepted
 *   (`profileSharing`);
 * - a group is accepted when any other member is a trusted contact. Desktop
 *   asks who *added* the user; signal-cli does not report that, so "someone
 *   you know is in it" stands in for it;
 * - either kind is also accepted when the user accepted it, or sent a message
 *   in it, on this device (`acceptedHere`, kept in `localStore`), or when it
 *   was already there before message requests existed (grandfathered once by
 *   SyncService, so an upgrade never turns existing chats into requests).
 *
 * A blocked chat is its own state: Desktop shows the same bar for it, with
 * "Unblock" in place of "Accept".
 *
 * Pure: it only reads what it is handed, so the services and the UI (which
 * read the stores differently) share exactly one definition.
 */
import { parseConversationId } from './ids';
import type { Contact, Conversation } from './types';

/** `request`: not accepted yet. `blocked`: the user blocked it. `accepted`: a normal chat. */
export type MessageRequestState = 'accepted' | 'request' | 'blocked';

export interface MessageRequestFacts {
  selfId: string | null;
  contact: (id: string) => Contact | undefined;
  /** Accepted on this device: accepted here, sent a message, or grandfathered. */
  acceptedHere: boolean;
}

/** The user themselves, a saved contact, or someone sharing profiles with the user. */
export function isTrustedContact(contact: Contact | undefined): boolean {
  return (
    contact !== undefined &&
    (contact.isSelf === true || contact.profileSharing === true || contact.inContacts === true)
  );
}

/** Whether the user blocked this conversation (the peer, for a direct chat). */
export function isConversationBlocked(
  conversation: Pick<Conversation, 'id' | 'blocked'>,
  contact: (id: string) => Contact | undefined,
): boolean {
  const parsed = parseConversationId(conversation.id);
  if (parsed?.kind === 'direct') return contact(parsed.target)?.blocked === true;
  return conversation.blocked === true;
}

/** Desktop's `isConversationAccepted`, without the blocked state (see the file header). */
export function isConversationAccepted(
  conversation: Pick<Conversation, 'id' | 'memberIds'>,
  facts: MessageRequestFacts,
): boolean {
  if (facts.acceptedHere) return true;
  const parsed = parseConversationId(conversation.id);
  if (!parsed) return true;
  if (parsed.kind === 'direct') {
    return parsed.target === facts.selfId || isTrustedContact(facts.contact(parsed.target));
  }
  return conversation.memberIds.some(
    (id) => id !== facts.selfId && isTrustedContact(facts.contact(id)),
  );
}

export function messageRequestState(
  conversation: Pick<Conversation, 'id' | 'memberIds' | 'blocked'>,
  facts: MessageRequestFacts,
): MessageRequestState {
  if (isConversationBlocked(conversation, facts.contact)) return 'blocked';
  return isConversationAccepted(conversation, facts) ? 'accepted' : 'request';
}
