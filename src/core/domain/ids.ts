/**
 * Branded identifiers.
 *
 * Conversations and messages are addressed by plain strings on the wire, but
 * mixing them up (or passing a contact id where a conversation id is expected)
 * is an easy, silent bug. Brands make those mistakes type errors while staying
 * zero-cost at runtime. Always construct ids through the helpers below.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `dm:<aci|number>` or `group:<base64 group id>`. */
export type ConversationId = Brand<string, 'ConversationId'>;

/**
 * `${authorId}:${sentAt}` — Signal identifies a message by its author and the
 * sender's timestamp, so this pair is the only stable key we can rely on across
 * devices (edits, reactions, deletions and quotes all target it).
 * Optimistic (not yet acknowledged) messages use `pending:<nonce>` instead.
 */
export type MessageId = Brand<string, 'MessageId'>;

export type ConversationKind = 'direct' | 'group';

export function directConversationId(peerId: string): ConversationId {
  return `dm:${peerId}` as ConversationId;
}

export function groupConversationId(groupId: string): ConversationId {
  return `group:${groupId}` as ConversationId;
}

/** Parses a conversation id back into its parts; returns null for foreign strings. */
export function parseConversationId(
  value: string,
): { kind: ConversationKind; target: string } | null {
  if (value.startsWith('dm:') && value.length > 3)
    return { kind: 'direct', target: value.slice(3) };
  if (value.startsWith('group:') && value.length > 6)
    return { kind: 'group', target: value.slice(6) };
  return null;
}

/** Validates an untrusted string (e.g. from storage) as a ConversationId. */
export function asConversationId(value: string): ConversationId | null {
  return parseConversationId(value) ? (value as ConversationId) : null;
}

export function messageId(authorId: string, sentAt: number): MessageId {
  return `${authorId}:${sentAt}` as MessageId;
}

export function pendingMessageId(nonce: string): MessageId {
  return `pending:${nonce}` as MessageId;
}

export function isPendingMessageId(id: MessageId): boolean {
  return id.startsWith('pending:');
}

/**
 * Splits a message id at the *last* colon: author ids never contain one
 * (ACIs are UUIDs, numbers are E.164) but being defensive costs nothing.
 */
export function parseMessageId(id: MessageId): { authorId: string; sentAt: number } | null {
  const at = id.lastIndexOf(':');
  if (at <= 0) return null;
  const sentAt = Number(id.slice(at + 1));
  if (!Number.isSafeInteger(sentAt)) return null;
  return { authorId: id.slice(0, at), sentAt };
}
