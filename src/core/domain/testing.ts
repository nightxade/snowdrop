/**
 * Test factories for domain objects. Lives in core/domain (not src/test) so
 * domain tests stay within their own layer; it's tree-shaken from builds.
 */
import { groupConversationId, messageId, type ConversationId } from './ids';
import type { Conversation, Message } from './types';

export function conversationIdFor(key: string): ConversationId {
  return groupConversationId(key);
}

export function makeMessage(partial: Partial<Message> = {}): Message {
  const authorId = partial.authorId ?? 'author';
  const sentAt = partial.sentAt ?? 0;
  return {
    id: messageId(authorId, sentAt),
    conversationId: conversationIdFor('default'),
    authorId,
    sentAt,
    receivedAt: sentAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
    ...partial,
  };
}

export function makeConversation(partial: Partial<Conversation> = {}): Conversation {
  return {
    id: conversationIdFor('default'),
    kind: 'group',
    title: 'Conversation',
    memberIds: [],
    adminIds: [],
    muted: false,
    archived: false,
    pinned: false,
    expireTimerSec: 0,
    lastActivityAt: 0,
    ...partial,
  };
}
