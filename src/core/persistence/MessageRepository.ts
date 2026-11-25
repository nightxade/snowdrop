/**
 * Local message history.
 *
 * Stock signal-cli keeps no received-message history. Everything we see is
 * persisted here and the UI pages from this repository. Backends with history
 * (the phone-history patch or mock data) supply older pages on demand through
 * HistoryService, which persists them before exposing them to the UI.
 *
 * Ordering: messages are keyed by identity (`author:sentAt`) but *ordered* by
 * `seq`, a local arrival sequence the repository assigns. Sender clocks can
 * be wrong; arrival order can't. Backfilled (older) history gets seqs below
 * everything already stored so it lands before it.
 */
import type { SendInput } from '@/core/backend';
import {
  displayedText,
  foldedTerms,
  foldText,
  type ConversationId,
  type GalleryKind,
  type Message,
  type MessageId,
} from '@/core/domain';

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
  /**
   * The name a mention shows (`@name`): the text searched is the text as displayed, so a message
   * is found by the name of someone it mentions. Without it a mention is not searchable.
   */
  nameFor?: (id: string) => string;
  /** Abandons the scan; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Called with every match found so far (newest first, never more than
   * `limit`) each time a slice of the history turned up new ones, so a long
   * scan can show results before it finishes.
   */
  onPartial?: (matches: readonly Message[]) => void;
}

export interface MediaQuery {
  /** Only messages with seq < before (the last one of the previous page). */
  before?: number;
  /** Most messages to return. */
  limit: number;
  /** Abandons the scan; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** An outgoing message the backend hasn't acknowledged yet; survives reloads. */
export interface OutboxEntry {
  nonce: string;
  input: SendInput;
  createdAt: number;
  /**
   * True when `input.attachments` could not be reconstructed on read (data
   * written before attachment persistence existed, or storage that lost the
   * bytes some other way). `input.attachments` is then empty rather than
   * carrying unusable entries; callers should surface this rather than
   * attempt — and fail opaquely — to resend them.
   */
  attachmentsLost?: boolean;
}

/** The full-quality bytes of one of your own sent images (see `Attachment.original`). */
export interface SentMedia {
  /** The attachment's id. */
  id: string;
  data: Blob;
}

/** What the kept originals of sent images take up (see `Attachment.original`). */
export interface SentOriginalsUsage {
  /** How many images. */
  photos: number;
  /** Their stored size in bytes. */
  bytes: number;
}

/** Which kept originals a measure or a drop covers: those of messages sent before `olderThan`. */
export interface SentOriginalsScope {
  /** Epoch ms: only messages with `sentAt` below this. `Infinity` covers every message. */
  olderThan: number;
  /** Abandons the scan; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Messages looked at so far, out of all stored. Called between slices of the scan. */
  onProgress?: (done: number, total: number) => void;
}

/** What `dropSentOriginals` removed. */
export interface SentOriginalsDropped extends SentOriginalsUsage {
  /** The attachment ids whose `original` flag was cleared (for in-memory copies of the messages). */
  attachmentIds: string[];
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
   * Search that ignores case, diacritics and Unicode normal forms: every
   * whitespace-separated term must appear in the message as displayed (the
   * body with mentions as `@name`, a poll's question for a poll). Across
   * every conversation unless `conversationId` is given. Within a
   * conversation: newest first by arrival, a scan that stops at `limit`
   * matches. Across conversations: newest first by sent time, the `limit`
   * most recent matches of the whole history (so the scan reads all of it,
   * reporting what it has found as it goes). Implementations that must
   * decrypt rows work in slices, yielding between them, and honour
   * `signal` and `onPartial` (see SearchQuery).
   */
  search(text: string, query: SearchQuery): Promise<Message[]>;
  /**
   * A conversation's gallery tab (see `GalleryKind`): the messages that have
   * something for it, newest first, one page at a time. Page on by passing
   * the last message's `seq` as `before`; fewer than `limit` back means the
   * history is exhausted. Attachment kinds are only readable once decrypted,
   * so implementations that decrypt rows scan in slices, yield between
   * them and honour `signal`, as `search` does.
   */
  media(conversationId: ConversationId, kind: GalleryKind, query: MediaQuery): Promise<Message[]>;
  /** Messages mentioning a contact, newest first (the mentions inbox). */
  mentions(contactId: string, query: { before?: number; limit: number }): Promise<Message[]>;
  /** Pinned messages of a conversation, newest first (the header's pins popover). */
  pinned(conversationId: ConversationId, limit: number): Promise<Message[]>;
  /** Messages whose expiresAt has passed (disappearing messages). */
  expired(now: number, limit: number): Promise<Message[]>;
  /** Imported timers that need their authoritative deadline checked after reconnect. */
  pendingHistoryTimers(): Promise<Message[]>;

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
  commitOutgoing(
    nonce: string,
    final: Message,
    merge: MergeFn,
    /**
     * Full-quality copies of `final`'s images, stored in the same transaction.
     * They are removed with the message: deleted (for me or everyone),
     * expired, its conversation deleted, or all history cleared.
     */
    media?: readonly SentMedia[],
  ): Promise<UpsertResult>;
  /** A kept original (see `Attachment.original`), labelled `type`; undefined if there is none. */
  readSentMedia(id: string, type: string): Promise<Blob | undefined>;
  /**
   * The space the kept originals take. Without a scope it sums the stored
   * sizes without decrypting anything. With one it covers only the messages
   * sent before `olderThan`, which means decrypting messages (sliced, yielding
   * between slices; see SentOriginalsScope).
   */
  sentOriginalsUsage(scope?: SentOriginalsScope): Promise<SentOriginalsUsage>;
  /**
   * Removes the kept originals of messages sent before `olderThan` and clears
   * `original` on their attachments, so every surface falls back to the
   * preview. Each message is handled in its own transaction (copy removed and
   * flag cleared together), queued with the other writes. A message that
   * can't be read is skipped, never deleted.
   */
  dropSentOriginals(scope: SentOriginalsScope): Promise<SentOriginalsDropped>;
  /** Atomically drops an unsent message's pending row and outbox entry. */
  discardOutgoing(nonce: string): Promise<void>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  deleteOutbox(nonce: string): Promise<void>;
  listOutbox(): Promise<OutboxEntry[]>;

  /**
   * Removes a conversation's stored messages (pending ones included), its
   * read position, its kept sent images and its queued outbox sends (deleting
   * a message request), so nothing of it comes back on the next start.
   */
  deleteConversation(conversationId: ConversationId): Promise<void>;

  /** Resolves once every write started before the call has reached storage. */
  flush(): Promise<void>;

  /** Wipes all local history ("Data & Storage → clear"). */
  clear(): Promise<void>;
}

/**
 * The ids of the kept originals `before` had that `after` no longer has: the
 * attachment went away (delete for everyone, the message deleted), so its
 * stored copy has to go too. `after` undefined means the message is gone.
 */
export function droppedOriginals(
  before: Message | undefined,
  after: Message | undefined,
): string[] {
  if (!before) return [];
  const kept = new Set(
    (after?.attachments ?? []).filter((a) => a.original === true).map((a) => a.id),
  );
  return before.attachments.filter((a) => a.original === true && !kept.has(a.id)).map((a) => a.id);
}

/** The attachment ids of the kept originals `message` carries. */
export function originalIds(message: Message): string[] {
  return message.attachments.filter((a) => a.original === true).map((a) => a.id);
}

/**
 * The text a search matches: the message as it reads on screen (a mention as `@name` when
 * `nameFor` is given, a poll's question for a poll), see `displayedText`.
 */
export function searchableText(message: Message, nameFor?: (id: string) => string): string {
  return displayedText(message, nameFor);
}

/**
 * Search matching shared by implementations: every term (see `searchTerms`) appears in the
 * folded text of the message (case, diacritics and Unicode normal forms ignored).
 */
export function matchesSearch(
  message: Message,
  terms: readonly string[],
  nameFor?: (id: string) => string,
): boolean {
  if (message.deleted || message.kind !== 'normal') return false;
  const text = foldText(searchableText(message, nameFor));
  return terms.every((t) => text.includes(t));
}

/** Newest sent first, arrival order breaking a tie: how a search across every conversation orders its matches. */
export function newestSentFirst(a: Message, b: Message): number {
  return b.sentAt - a.sentAt || (b.seq ?? 0) - (a.seq ?? 0);
}

/** The folded words of a query (`foldedTerms`). */
export function searchTerms(text: string): string[] {
  return foldedTerms(text);
}

/** Newest-first batches; one round trip answers almost every conversation. */
const REAL_MESSAGE_PAGE = 50;

/**
 * The newest real (non-system) message stored for a conversation, paging
 * back from the latest batch, or undefined if it has none. `latest()`
 * answers the absolute newest *stored* message regardless of kind — a
 * system line (a decrypt failure, a timer change) is stored too, so the
 * conversation can show it, but it must never stand in for "this
 * conversation has a real message" (ordering a chat like the phone, or
 * telling a stale peer-metadata-only direct conversation from one that
 * genuinely has history — see SyncService's `seedConversation` and
 * `dropStaleDirects`).
 */
export async function latestRealMessage(
  repository: MessageRepository,
  conversationId: ConversationId,
): Promise<Message | undefined> {
  let before: number | undefined;
  for (;;) {
    const page = await repository.page(conversationId, {
      ...(before === undefined ? {} : { before }),
      limit: REAL_MESSAGE_PAGE,
    });
    if (page.length === 0) return undefined;
    const real = [...page].reverse().find((m) => m.kind === 'normal');
    if (real) return real;
    before = page[0]?.seq;
    if (before === undefined) return undefined;
  }
}

/**
 * The message the sidebar previews: the newest stored one that may stand as a
 * preview (everything but a `previewless` line), paging back from the latest
 * batch. Equals `repository.latest()` unless the newest lines are previewless.
 */
export async function latestPreviewMessage(
  repository: Pick<MessageRepository, 'page' | 'latest'>,
  conversationId: ConversationId,
): Promise<Message | undefined> {
  const newest = await repository.latest(conversationId);
  if (!newest || newest.previewless !== true) return newest;
  let before: number | undefined = newest.seq;
  for (;;) {
    if (before === undefined) return undefined;
    const page = await repository.page(conversationId, { before, limit: REAL_MESSAGE_PAGE });
    if (page.length === 0) return undefined;
    const found = [...page].reverse().find((m) => m.previewless !== true);
    if (found) return found;
    before = page[0]?.seq;
  }
}
