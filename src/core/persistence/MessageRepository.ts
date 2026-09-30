/**
 * Local message history.
 *
 * signal-cli keeps no history: once an envelope is received it's gone. So
 * everything we see is persisted here and the UI pages history from this
 * repository, never from the backend (except the mock's optional seed
 * history, which the history service copies in on demand).
 */
import type { ConversationId, Message, MessageId } from '@/core/domain';

export interface PageQuery {
  /** Only messages with sentAt strictly less than this; omit for the newest. */
  before?: number;
  limit: number;
}

export interface MessageRepository {
  get(id: MessageId): Promise<Message | undefined>;
  put(message: Message): Promise<void>;
  putMany(messages: readonly Message[]): Promise<void>;
  /**
   * Read-modify-write in one transaction so concurrent events (an edit and a
   * reaction arriving together) can't clobber each other.
   * Resolves with the updated message, or undefined if it doesn't exist.
   */
  update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined>;
  delete(id: MessageId): Promise<void>;

  /** Newest `limit` messages matching the query, returned ascending by sentAt. */
  page(conversationId: ConversationId, query: PageQuery): Promise<Message[]>;
  /** All messages with sentAt strictly greater than `after`, ascending. */
  listAfter(conversationId: ConversationId, after: number): Promise<Message[]>;
  count(conversationId: ConversationId): Promise<number>;

  /** Per-conversation read positions (sentAt of the last read message). */
  getReadCursors(): Promise<Map<ConversationId, number>>;
  setReadCursor(conversationId: ConversationId, sentAt: number): Promise<void>;

  /** Wipes all local history ("Data & Storage → clear"). */
  clear(): Promise<void>;
}

/** Messages persist without transient client-only fields. */
export function toStored(message: Message): Message {
  if (message.nonce === undefined) return message;
  const { nonce: _nonce, ...rest } = message;
  return rest;
}
