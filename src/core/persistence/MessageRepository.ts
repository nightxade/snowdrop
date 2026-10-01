/**
 * Local message history.
 *
 * signal-cli keeps no history: once an envelope is received it's gone. So
 * everything we see is persisted here and the UI pages history from this
 * repository, never from the backend (except the mock's optional seed
 * history, which the history service copies in on demand).
 *
 * Ordering: messages are keyed by identity (`author:sentAt`) but *ordered* by
 * `seq`, a local arrival sequence the repository assigns. Sender clocks can
 * be wrong; arrival order can't. Backfilled (older) history gets seqs below
 * everything already stored so it lands before it.
 */
import type { SendInput } from '@/core/backend';
import { mentionsOf, type ConversationId, type Message, type MessageId } from '@/core/domain';

/** Seq bounds are exclusive. With neither bound, returns the newest page. */
export interface PageQuery {
  /** Newest `limit` messages with seq < before. */
  before?: number;
  /** Oldest `limit` messages with seq > after. */
  after?: number;
  limit: number;
}

export interface UpsertResult {
  /** The stored message (merged, with seq). */
  message: Message;
  /** False when the message already existed and was merged. */
  created: boolean;
}

export type MergeFn = (existing: Message, incoming: Message) => Message;

export interface SearchQuery {
  conversationId?: ConversationId;
  limit: number;
}

/** An outgoing message the backend hasn't acknowledged yet; survives reloads. */
export interface OutboxEntry {
  nonce: string;
  input: SendInput;
  createdAt: number;
}

export interface MessageRepository {
  get(id: MessageId): Promise<Message | undefined>;
  /**
   * Inserts a message, or merges it into the stored copy (duplicate
   * delivery, sync echo) in one transaction. New messages get the next seq
   * unless they already carry one (optimistic sends reserve theirs).
   */
  upsert(message: Message, merge: MergeFn): Promise<UpsertResult>;
  /**
   * Bulk insert in timeline order. With `backfill`, new messages get seqs
   * *below* everything stored (older history); otherwise above. Existing
   * messages are merged and keep their seq.
   */
  upsertMany(
    messages: readonly Message[],
    options: { backfill: boolean; merge: MergeFn },
  ): Promise<Message[]>;
  /** Read-modify-write in one transaction; undefined if missing. */
  update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined>;
  delete(id: MessageId): Promise<void>;
  /** Reserves a seq for a message that will be stored later (optimistic sends). */
  allocateSeq(): Promise<number>;

  /** A page in ascending seq order; see PageQuery. */
  page(conversationId: ConversationId, query: PageQuery): Promise<Message[]>;
  /** Every message with seq > after, ascending (unread computation). */
  listAfter(conversationId: ConversationId, after: number): Promise<Message[]>;
  latest(conversationId: ConversationId): Promise<Message | undefined>;
  count(conversationId: ConversationId): Promise<number>;

  /**
   * Case-insensitive search: every whitespace-separated term must appear in
   * the body. Newest first. A linear scan for now; a token index can replace
   * it behind this interface when histories grow.
   */
  search(text: string, query: SearchQuery): Promise<Message[]>;
  /** Messages mentioning a contact, newest first (the mentions inbox). */
  mentions(contactId: string, query: { before?: number; limit: number }): Promise<Message[]>;
  /** Pinned messages of a conversation, newest first (the header's pins popover). */
  pinned(conversationId: ConversationId, limit: number): Promise<Message[]>;
  /** Messages whose expiresAt has passed (disappearing messages). */
  expired(now: number, limit: number): Promise<Message[]>;

  /** Per-conversation read positions (seq of the last read message). */
  getReadCursors(): Promise<Map<ConversationId, number>>;
  setReadCursor(conversationId: ConversationId, seq: number): Promise<void>;

  /**
   * Stores an outgoing message's pending row *and* its outbox entry in one
   * transaction, so a crash can't leave one without the other.
   */
  stageOutgoing(pending: Message, entry: OutboxEntry): Promise<void>;
  /**
   * Atomically replaces a pending row with the acknowledged message: deletes
   * `pending:<nonce>` and the outbox entry, and upserts `final` (merging with
   * anything already stored under its real id, e.g. a sync echo).
   */
  commitOutgoing(nonce: string, final: Message, merge: MergeFn): Promise<UpsertResult>;
  /** Atomically drops an unsent message's pending row and outbox entry. */
  discardOutgoing(nonce: string): Promise<void>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  deleteOutbox(nonce: string): Promise<void>;
  listOutbox(): Promise<OutboxEntry[]>;

  /** Wipes all local history ("Data & Storage → clear"). */
  clear(): Promise<void>;
}

/** Search matching shared by implementations. */
export function matchesSearch(message: Message, terms: readonly string[]): boolean {
  if (message.deleted || message.kind !== 'normal') return false;
  const body = message.body.toLowerCase();
  return terms.every((t) => body.includes(t));
}

export function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

/** What IndexedDB stores: the message plus a derived, indexable mention list. */
export type StoredMessage = Message & { mentionIds: string[] };

export function toStored(message: Message): StoredMessage {
  return { ...message, mentionIds: mentionsOf(message) };
}

export function fromStored(stored: StoredMessage): Message {
  const { mentionIds: _mentions, ...message } = stored;
  return message;
}
