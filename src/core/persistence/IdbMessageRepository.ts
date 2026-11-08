/**
 * IndexedDB-backed MessageRepository, encrypted (docs/ENCRYPTION.md, "Web
 * cache").
 *
 * Every record's body lives only as ciphertext (`payload`), AEAD-bound to
 * its own stored (blinded) id as AAD so a row can't be moved to another key
 * and decrypted there. Conversation ids and mention/contact ids are
 * replaced by `cipher.blindId(...)` wherever they'd otherwise appear as an
 * index key, so the index itself never reveals who a message is with.
 * `seq` and `expiresAt` stay plaintext: ordering, paging and the
 * disappearing-message purge need range queries over them, and
 * docs/ENCRYPTION.md accepts that as a documented leak of *when*, not *what*
 * or *who*. With `plaintextCipher` (browser/dev/mock, no vault), all of this
 * is the identity transform, so the stored shape is the same as before this
 * feature existed, just with the bytes passed through `TextEncoder`.
 *
 * A style note that recurs through this file: every encrypt/decrypt/blindId
 * call happens *outside* any open IndexedDB transaction (snapshot reads,
 * then crypto, then a transaction that only ever does plain IndexedDB
 * requests). Awaiting WebCrypto in the middle of a transaction's request
 * chain risks the transaction auto-committing out from under it — a real
 * cross-browser footgun, not a theoretical one. The cost is a little less
 * atomicity in a couple of read-modify-write paths (noted inline); given
 * this is a resyncable local cache, that trade is the right one.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { OutgoingAttachment, SendInput } from '@/core/backend';
import {
  hasGalleryItems,
  mentionsOf,
  pendingMessageId,
  type ConversationId,
  type GalleryKind,
  type Message,
  type MessageId,
} from '@/core/domain';
import { createLogger, yieldToEventLoop } from '@/core/lib';
import { plaintextCipher, utf8Decode, utf8Encode, type RecordCipher } from './crypto';
import {
  droppedOriginals,
  matchesSearch,
  originalIds,
  searchTerms,
  type MergeFn,
  type MediaQuery,
  type MessageRepository,
  type OutboxEntry,
  type PageQuery,
  type SearchQuery,
  type SentMedia,
  type SentOriginalsDropped,
  type SentOriginalsScope,
  type SentOriginalsUsage,
  type UpsertResult,
} from './MessageRepository';

const DB_VERSION = 6;
/** Rows read per slice of a search: decrypted together, then the event loop gets a turn. */
const SEARCH_SLICE = 500;
const SEQ_KEY = 'seq';
const log = createLogger('storage');

interface SeqState {
  key: typeof SEQ_KEY;
  min: number;
  max: number;
}

/** What's actually in the `messages` store: index sidecar fields plus the encrypted body. */
interface MessageRow {
  /** `cipher.blindId(message.id)` — the primary key, and the AAD for `payload`. */
  id: string;
  /** `cipher.blindId(message.conversationId)`. */
  conversationKey: string;
  seq: number;
  expiresAt?: number;
  /** `cipher.blindId(contactId)` for each mention — the mentions inbox stays queryable. */
  mentionIds: string[];
  /** AES-GCM of the full `Message` JSON, AAD = `id`. */
  payload: Uint8Array;
}

interface CursorRow {
  /** `cipher.blindId(conversationId)`. */
  id: string;
  /** AES-GCM of `{ conversationId, seq }`, AAD = `id`. */
  payload: Uint8Array;
}

interface OutboxRow {
  /** Plaintext: a random client nonce, not user data — nothing to blind. */
  nonce: string;
  createdAt: number;
  /**
   * How many `outboxAttachments` rows (keyed `${nonce}:0` … `${nonce}:${n-1}`)
   * go with this entry. `undefined` means this row predates attachment
   * persistence (DB_VERSION < 3): any attachments it names were serialised
   * as `JSON.stringify(Blob)` (`{}`) and their bytes are gone for good.
   */
  attachmentCount?: number;
  /** AES-GCM of `{ input }` (attachments reduced to name/type metadata), AAD = `nonce`. */
  payload: Uint8Array;
}

/**
 * One outgoing attachment's raw bytes, stored apart from `OutboxRow` because
 * `JSON.stringify(Blob)` is `{}` — a Blob simply can't ride along in the
 * same encrypted JSON payload as the rest of the send input.
 */
interface OutboxAttachmentRow {
  /**
   * `${nonce}:${index}` — the primary key, and the AAD binding it to that slot.
   * The attachment's name and type live in the entry's encrypted payload
   * (`StoredSendInput`), never on this row: rows written before DB_VERSION 4
   * carried them as plaintext fields, which the v4 upgrade strips.
   */
  id: string;
  /** AES-GCM of the raw attachment bytes, AAD = `id`. */
  payload: Uint8Array;
}

/**
 * The full-quality bytes of one of your own sent images, apart from the
 * message row (a Blob can't ride in its JSON payload, and the bytes would
 * make every message read heavy). Removed with the message.
 */
interface SentMediaRow {
  /** `cipher.blindId(attachment.id)` — the primary key, and the AAD for `payload`. */
  id: string;
  /** `cipher.blindId(message.conversationId)`: deleting a conversation removes its media. */
  conversationKey: string;
  /** AES-GCM of the image bytes, AAD = `id`. */
  payload: Uint8Array;
}

/** `SendInput` as actually stored: each attachment's Blob replaced by its metadata. */
type StoredSendInput = Omit<SendInput, 'attachments'> & {
  attachments?: { fileName: string; contentType: string; voiceNote?: boolean }[];
};

interface SnowdropDB extends DBSchema {
  messages: {
    key: string;
    value: MessageRow;
    indexes: {
      byConversationSeq: [string, number];
      byMention: string;
      byExpiresAt: number;
      bySeq: number;
    };
  };
  readCursors: { key: string; value: CursorRow };
  meta: { key: string; value: SeqState };
  outbox: { key: string; value: OutboxRow };
  outboxAttachments: { key: string; value: OutboxAttachmentRow };
  sentMedia: { key: string; value: SentMediaRow; indexes: { byConversation: string } };
}

/** The message with `original` cleared on the attachments `drop` picks (their copy is not kept). */
function withoutOriginals(message: Message, drop: (attachmentId: string) => boolean): Message {
  return {
    ...message,
    attachments: message.attachments.map((a) => {
      if (a.original !== true || !drop(a.id)) return a;
      const { original: _original, ...rest } = a;
      return rest;
    }),
  };
}

const encodeJson = (value: unknown): Uint8Array => utf8Encode(JSON.stringify(value));
const outboxAttachmentId = (nonce: string, index: number): string => `${nonce}:${index}`;

export class IdbMessageRepository implements MessageRepository {
  /**
   * Serialises every mutation (upsert, update, commitOutgoing, …) behind a
   * promise-chain mutex. Each of those reads a row, decrypts it, merges, and
   * only then opens a (plain, synchronous) IDB transaction to write it back
   * — crypto has to stay outside the transaction (see the file header), so
   * the read and the write aren't atomic from IndexedDB's point of view.
   * Two mutations racing on the same row would otherwise both read the old
   * value and one write would clobber the other (a lost field update, or a
   * duplicate seq). Reads that don't feed a write (get, page, search, …)
   * aren't funnelled through this and stay concurrent.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly db: IDBPDatabase<SnowdropDB>,
    private readonly cipher: RecordCipher,
  ) {}

  /** Runs `fn` only after every previously queued mutation has settled. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    // Keep the chain alive even if this mutation rejects; the rejection
    // still propagates to this call's own caller via `run`.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  static async open(
    name = 'snowdrop',
    cipher: RecordCipher = plaintextCipher(),
  ): Promise<IdbMessageRepository> {
    const db = await openDB<SnowdropDB>(name, DB_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        // Versioned, additive migrations: each step upgrades from the previous version.
        if (oldVersion >= 1 && oldVersion < 2) {
          // v1 stored everything in plaintext, indexed by the real
          // conversation id (and `readCursors` was keyed by it directly).
          // Reconciling that into v2's blinded index would mean
          // re-encrypting every row with async WebCrypto calls inside this
          // versionchange transaction, which IndexedDB doesn't reliably
          // keep alive across (see the file header). Deleting and
          // recreating is the safer choice the contract allows: this is a
          // resync-able cache, not the source of truth — signal-cli resends
          // history to a fresh repository, at the cost of outstanding
          // outbox entries, which the user would need to resend.
          database.deleteObjectStore('messages');
          database.deleteObjectStore('readCursors');
          database.deleteObjectStore('meta');
          database.deleteObjectStore('outbox');
        }
        if (oldVersion < 2) {
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('byConversationSeq', ['conversationKey', 'seq']);
          messages.createIndex('byMention', 'mentionIds', { multiEntry: true });
          messages.createIndex('byExpiresAt', 'expiresAt');
          database.createObjectStore('readCursors', { keyPath: 'id' });
          database.createObjectStore('meta', { keyPath: 'key' });
          database.createObjectStore('outbox', { keyPath: 'nonce' });
        }
        if (oldVersion < 3) {
          // Additive: existing outbox rows are left as-is (they predate
          // `attachmentCount` and are handled as "attachments lost" on
          // read — see fromOutboxRow); nothing here needs re-encrypting.
          database.createObjectStore('outboxAttachments', { keyPath: 'id' });
        }
        if (oldVersion < 6) {
          // Additive: kept originals of sent images (see `Attachment.original`).
          const media = database.createObjectStore('sentMedia', { keyPath: 'id' });
          media.createIndex('byConversation', 'conversationKey');
        }
        if (oldVersion < 5) {
          // Search across every conversation walks newest first and stops
          // at its limit. `seq` is already plaintext, so this adds no leak.
          transaction.objectStore('messages').createIndex('bySeq', 'seq');
        }
        if (oldVersion >= 3 && oldVersion < 4) {
          // Attachment file names and types were stored as plaintext fields
          // beside the encrypted bytes. The same metadata is already inside
          // the owning outbox entry's encrypted payload (that's what
          // `fromOutboxRow` reads), so nothing needs re-encrypting: the
          // plaintext copies are simply removed, in this same transaction,
          // with plain IndexedDB requests only (no crypto, no other awaits).
          void (async () => {
            let cursor = await transaction.objectStore('outboxAttachments').openCursor();
            while (cursor) {
              const { id, payload } = cursor.value;
              await cursor.update({ id, payload });
              cursor = await cursor.continue();
            }
          })().catch(() => {
            // A failed rewrite aborts the whole upgrade, leaving the old
            // (still readable) database in place for the next attempt.
            transaction.abort();
          });
        }
      },
    });
    return new IdbMessageRepository(db, cipher);
  }

  close(): void {
    this.db.close();
  }

  /** Resolves once every mutation queued so far has settled (it never rejects). */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async pendingHistoryTimers(): Promise<Message[]> {
    // These fields remain inside the encrypted payload. Reconcile once at
    // startup, without adding a plaintext index exposing which rows were read.
    const messages = await this.fromRows(await this.db.getAll('messages'));
    return messages.filter(
      (message) =>
        message.historyCursor && message.expiresAfterReadMs && message.expiresAt === undefined,
    );
  }

  private async toRow(message: Message): Promise<MessageRow> {
    const [id, conversationKey, mentionIds] = await Promise.all([
      this.cipher.blindId(message.id),
      this.cipher.blindId(message.conversationId),
      Promise.all(mentionsOf(message).map((m) => this.cipher.blindId(m))),
    ]);
    const payload = await this.cipher.encrypt(encodeJson(message), id);
    return {
      id,
      conversationKey,
      seq: message.seq ?? 0,
      mentionIds,
      payload,
      ...(message.expiresAt !== undefined ? { expiresAt: message.expiresAt } : {}),
    };
  }

  private async fromRow(row: MessageRow): Promise<Message> {
    const plain = await this.cipher.decrypt(row.payload, row.id);
    return JSON.parse(utf8Decode(plain)) as Message;
  }

  /**
   * The stored message, or undefined when its row can't be read (corrupted,
   * tampered, or sealed under a different key). Mutations use this for the
   * row they are about to replace: an unreadable one is treated as absent, so
   * it can't block writes to its id for good. Logs a count, never the id.
   */
  private async tryFromRow(row: MessageRow | undefined): Promise<Message | undefined> {
    if (!row) return undefined;
    try {
      return await this.fromRow(row);
    } catch {
      log.warn('replacing 1 unreadable message row');
      return undefined;
    }
  }

  /**
   * Decrypts a batch of rows independently: one unreadable row (corrupted,
   * tampered, or sealed under a different key — e.g. left over from a
   * previous vault) is dropped rather than failing the whole batch, so a
   * single bad row can't hide an entire conversation's history or the whole
   * read-cursor/outbox table behind a thrown error. Logged once, aggregated,
   * and never with the row's contents or id.
   */
  private async decodeBatch<Row, Out>(
    rows: readonly Row[],
    decode: (row: Row) => Promise<Out>,
    what: string,
  ): Promise<Out[]> {
    const settled = await Promise.allSettled(rows.map((row) => decode(row)));
    const out: Out[] = [];
    let dropped = 0;
    for (const result of settled) {
      if (result.status === 'fulfilled') out.push(result.value);
      else dropped++;
    }
    if (dropped > 0) {
      log.warn(`dropped ${dropped} unreadable ${what} row(s)`);
    }
    return out;
  }

  private async fromRows(rows: readonly MessageRow[]): Promise<Message[]> {
    return this.decodeBatch(rows, (row) => this.fromRow(row), 'message');
  }

  private async seqStateOnce(): Promise<SeqState> {
    return (await this.db.get('meta', SEQ_KEY)) ?? { key: SEQ_KEY, min: 1, max: 0 };
  }

  private async seqState(
    tx: IDBPTransaction<SnowdropDB, ('messages' | 'meta')[], 'readwrite'>,
  ): Promise<SeqState> {
    return (await tx.objectStore('meta').get(SEQ_KEY)) ?? { key: SEQ_KEY, min: 1, max: 0 };
  }

  async get(id: MessageId): Promise<Message | undefined> {
    const key = await this.cipher.blindId(id);
    const row = await this.db.get('messages', key);
    return row ? this.fromRow(row) : undefined;
  }

  upsert(message: Message, merge: MergeFn): Promise<UpsertResult> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(message.id);
      const existing = await this.tryFromRow(await this.db.get('messages', key));
      if (existing) {
        const merged = merge(existing, message);
        await this.writeDropping([await this.toRow(merged)], droppedOriginals(existing, merged));
        return { message: merged, created: false };
      }
      const seq = await this.seqStateOnce();
      const stored = { ...message, seq: message.seq ?? seq.max + 1 };
      const row = await this.toRow(stored);
      const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
      await Promise.all([
        tx.objectStore('messages').put(row),
        tx.objectStore('meta').put({
          ...seq,
          max: Math.max(seq.max, stored.seq),
          min: Math.min(seq.min, stored.seq),
        }),
        tx.done,
      ]);
      return { message: stored, created: true };
    });
  }

  upsertMany(
    messages: readonly Message[],
    { backfill, merge }: { backfill: boolean; merge: MergeFn },
  ): Promise<Message[]> {
    return this.mutate(async () => {
      const keys = await Promise.all(messages.map((m) => this.cipher.blindId(m.id)));
      const existingRows = await Promise.all(keys.map((key) => this.db.get('messages', key)));
      const existing = await Promise.all(existingRows.map((row) => this.tryFromRow(row)));
      const freshCount = existing.filter((e) => e === undefined).length;
      const seq = await this.seqStateOnce();
      let next = backfill ? seq.min - freshCount : seq.max + 1;
      const out: Message[] = [];
      let min = seq.min;
      let max = seq.max;
      for (const [i, m] of messages.entries()) {
        const found = existing[i];
        const stored = found ? merge(found, m) : { ...m, seq: m.seq ?? next++ };
        if (stored.seq !== undefined) {
          min = Math.min(min, stored.seq);
          max = Math.max(max, stored.seq);
        }
        out.push(stored);
      }
      const rows = await Promise.all(out.map((m) => this.toRow(m)));
      const dropKeys = await this.mediaKeys(
        out.flatMap((m, i) => droppedOriginals(existing[i], m)),
      );
      const tx = this.db.transaction(['messages', 'meta', 'sentMedia'], 'readwrite');
      await Promise.all([
        ...rows.map((row) => tx.objectStore('messages').put(row)),
        tx.objectStore('meta').put({ key: SEQ_KEY, min, max }),
        ...dropKeys.map((key) => tx.objectStore('sentMedia').delete(key)),
        tx.done,
      ]);
      return out;
    });
  }

  update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(id);
      const before = await this.tryFromRow(await this.db.get('messages', key));
      if (!before) return undefined;
      // Updates never move a message in the timeline.
      const next: Message =
        before.seq === undefined ? fn(before) : { ...fn(before), seq: before.seq };
      await this.writeDropping([await this.toRow(next)], droppedOriginals(before, next));
      return next;
    });
  }

  delete(id: MessageId): Promise<void> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(id);
      const before = await this.tryFromRow(await this.db.get('messages', key));
      const dropKeys = await this.mediaKeys(droppedOriginals(before, undefined));
      const tx = this.db.transaction(['messages', 'sentMedia'], 'readwrite');
      await Promise.all([
        tx.objectStore('messages').delete(key),
        ...dropKeys.map((k) => tx.objectStore('sentMedia').delete(k)),
        tx.done,
      ]);
    });
  }

  private mediaKeys(attachmentIds: readonly string[]): Promise<string[]> {
    return Promise.all(attachmentIds.map((id) => this.cipher.blindId(id)));
  }

  /**
   * Writes message rows and removes the kept originals of attachments they no
   * longer have in one transaction, so an original can't outlive its message.
   */
  private async writeDropping(
    rows: readonly MessageRow[],
    droppedAttachmentIds: readonly string[],
  ): Promise<void> {
    const dropKeys = await this.mediaKeys(droppedAttachmentIds);
    const tx = this.db.transaction(['messages', 'sentMedia'], 'readwrite');
    await Promise.all([
      ...rows.map((row) => tx.objectStore('messages').put(row)),
      ...dropKeys.map((key) => tx.objectStore('sentMedia').delete(key)),
      tx.done,
    ]);
  }

  async readSentMedia(id: string, type: string): Promise<Blob | undefined> {
    const key = await this.cipher.blindId(id);
    const row = await this.db.get('sentMedia', key);
    if (!row) return undefined;
    const bytes = await this.cipher.decrypt(row.payload, row.id);
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  }

  async sentOriginalsUsage(scope?: SentOriginalsScope): Promise<SentOriginalsUsage> {
    if (scope === undefined) {
      // Stored sizes only: nothing is decrypted, and no message is read.
      let photos = 0;
      let bytes = 0;
      let cursor = await this.db.transaction('sentMedia').store.openCursor();
      while (cursor) {
        photos++;
        bytes += cursor.value.payload.byteLength;
        cursor = await cursor.continue();
      }
      return { photos, bytes };
    }
    const messages = await this.messagesWithOriginals(scope);
    return this.originalsSize(messages.flatMap(originalIds), scope.signal);
  }

  async dropSentOriginals(scope: SentOriginalsScope): Promise<SentOriginalsDropped> {
    const dropped: SentOriginalsDropped = { photos: 0, bytes: 0, attachmentIds: [] };
    for (const { id } of await this.messagesWithOriginals(scope)) {
      scope.signal?.throwIfAborted();
      // One message per queued write, so a send can slip in between two of them.
      await this.mutate(async () => {
        const key = await this.cipher.blindId(id);
        // Read again under the queue: it may have changed since the scan.
        const row = await this.db.get('messages', key);
        if (!row) return;
        let message: Message;
        try {
          message = await this.fromRow(row);
        } catch {
          return; // Unreadable: left exactly as it is.
        }
        if (message.sentAt >= scope.olderThan) return;
        const ids = originalIds(message);
        if (ids.length === 0) return;
        const size = await this.originalsSize(ids);
        // The copies and the flags go in one transaction: no flag outlives its copy.
        const next = withoutOriginals(message, () => true);
        await this.writeDropping([await this.toRow(next)], ids);
        dropped.photos += size.photos;
        dropped.bytes += size.bytes;
        dropped.attachmentIds.push(...ids);
      });
    }
    return dropped;
  }

  /**
   * The messages sent before `scope.olderThan` that carry kept originals.
   * Their bodies are only readable decrypted, so this is the same sliced walk
   * as `search`: a bounded read, a decrypt, then a turn for the event loop.
   * Rows that can't be read are skipped (and counted in one log line).
   */
  private async messagesWithOriginals({
    olderThan,
    signal,
    onProgress,
  }: SentOriginalsScope): Promise<Message[]> {
    signal?.throwIfAborted();
    const total = await this.db.count('messages');
    const found: Message[] = [];
    let done = 0;
    let upper = Infinity;
    let tail = new Set<string>();
    for (;;) {
      const slice = await this.readSearchSlice(undefined, upper, tail);
      if (slice.length === 0) break;
      const last = slice[slice.length - 1] as MessageRow;
      tail = new Set([
        ...(last.seq === upper ? tail : []),
        ...slice.filter((row) => row.seq === last.seq).map((row) => row.id),
      ]);
      upper = last.seq;
      for (const message of await this.fromRows(slice)) {
        if (message.sentAt < olderThan && originalIds(message).length > 0) found.push(message);
      }
      done += slice.length;
      onProgress?.(Math.min(done, total), total);
      if (slice.length < SEARCH_SLICE) break;
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    return found;
  }

  /** The stored size of the originals under these attachment ids; ids with no copy count nothing. */
  private async originalsSize(
    attachmentIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<SentOriginalsUsage> {
    let photos = 0;
    let bytes = 0;
    for (const [i, key] of (await this.mediaKeys(attachmentIds)).entries()) {
      const row = await this.db.get('sentMedia', key);
      if (row) {
        photos++;
        bytes += row.payload.byteLength;
      }
      if (i % 20 === 19) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
    }
    return { photos, bytes };
  }

  allocateSeq(): Promise<number> {
    return this.mutate(async () => {
      const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
      const seq = await this.seqState(tx);
      const next = seq.max + 1;
      await tx.objectStore('meta').put({ ...seq, max: next });
      await tx.done;
      return next;
    });
  }

  private range(
    conversationKey: string,
    lower: number,
    upper: number,
    lowerOpen: boolean,
    upperOpen: boolean,
  ): IDBKeyRange {
    return IDBKeyRange.bound(
      [conversationKey, lower],
      [conversationKey, upper],
      lowerOpen,
      upperOpen,
    );
  }

  async page(
    conversationId: ConversationId,
    { before, after, limit }: PageQuery,
  ): Promise<Message[]> {
    const key = await this.cipher.blindId(conversationId);
    const index = this.db.transaction('messages').store.index('byConversationSeq');
    // Collect raw (still-encrypted) rows while the cursor is live, then
    // decrypt the batch afterwards — see the file header.
    const rows: MessageRow[] = [];
    if (after !== undefined) {
      let cursor = await index.openCursor(this.range(key, after, Infinity, true, false), 'next');
      while (cursor && rows.length < limit) {
        rows.push(cursor.value);
        cursor = await cursor.continue();
      }
      return this.fromRows(rows);
    }
    let cursor = await index.openCursor(
      this.range(key, -Infinity, before ?? Infinity, false, before !== undefined),
      'prev',
    );
    while (cursor && rows.length < limit) {
      rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    const messages = await this.fromRows(rows);
    return messages.reverse();
  }

  async listAfter(conversationId: ConversationId, after: number): Promise<Message[]> {
    const key = await this.cipher.blindId(conversationId);
    const rows = await this.db.getAllFromIndex(
      'messages',
      'byConversationSeq',
      this.range(key, after, Infinity, true, false),
    );
    return this.fromRows(rows);
  }

  async latest(conversationId: ConversationId): Promise<Message | undefined> {
    const [last] = await this.page(conversationId, { limit: 1 });
    return last;
  }

  async count(conversationId: ConversationId): Promise<number> {
    const key = await this.cipher.blindId(conversationId);
    return this.db.countFromIndex(
      'messages',
      'byConversationSeq',
      this.range(key, -Infinity, Infinity, false, false),
    );
  }

  async search(
    text: string,
    { conversationId, limit, signal, onPartial }: SearchQuery,
  ): Promise<Message[]> {
    const terms = searchTerms(text);
    if (terms.length === 0 || limit <= 0) return [];
    signal?.throwIfAborted();
    const key =
      conversationId === undefined ? undefined : await this.cipher.blindId(conversationId);
    const found: Message[] = [];
    // Body text is only readable once decrypted, so every row is a candidate:
    // walk newest first in slices of SEARCH_SLICE (a bounded read, then a
    // decrypt, then a turn for the event loop) and stop at `limit` matches.
    // `upper` resumes just below the previous slice; rows sharing its seq
    // are skipped by id rather than lost.
    let upper = Infinity;
    let tail = new Set<string>();
    for (;;) {
      const slice = await this.readSearchSlice(key, upper, tail);
      if (slice.length === 0) break;
      const last = slice[slice.length - 1] as MessageRow;
      tail = new Set([
        ...(last.seq === upper ? tail : []),
        ...slice.filter((row) => row.seq === last.seq).map((row) => row.id),
      ]);
      upper = last.seq;
      signal?.throwIfAborted();
      const before = found.length;
      for (const message of await this.fromRows(slice)) {
        if (found.length < limit && matchesSearch(message, terms)) found.push(message);
      }
      if (found.length >= limit || slice.length < SEARCH_SLICE) break;
      if (found.length > before) onPartial?.([...found]);
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    return found;
  }

  async media(
    conversationId: ConversationId,
    kind: GalleryKind,
    { before, limit, signal }: MediaQuery,
  ): Promise<Message[]> {
    if (limit <= 0) return [];
    signal?.throwIfAborted();
    const key = await this.cipher.blindId(conversationId);
    const found: Message[] = [];
    // The same sliced newest-first walk as `search`, since what an attachment
    // is only shows once its row is decrypted. `before` is exclusive; the
    // slice reader's bound is inclusive, so the row at `before` itself is
    // skipped by id when it comes back.
    let upper = before ?? Infinity;
    let tail = new Set<string>();
    for (;;) {
      const slice = await this.readSearchSlice(key, upper, tail);
      if (slice.length === 0) break;
      const last = slice[slice.length - 1] as MessageRow;
      tail = new Set([
        ...(last.seq === upper ? tail : []),
        ...slice.filter((row) => row.seq === last.seq).map((row) => row.id),
      ]);
      upper = last.seq;
      signal?.throwIfAborted();
      for (const message of await this.fromRows(slice)) {
        if (
          found.length < limit &&
          (before === undefined || (message.seq ?? 0) < before) &&
          hasGalleryItems(message, kind)
        )
          found.push(message);
      }
      if (found.length >= limit || slice.length < SEARCH_SLICE) break;
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    return found;
  }

  /** The next SEARCH_SLICE rows at or below `upper`, newest first, minus `skip`. */
  private async readSearchSlice(
    key: string | undefined,
    upper: number,
    skip: ReadonlySet<string>,
  ): Promise<MessageRow[]> {
    const rows: MessageRow[] = [];
    const store = this.db.transaction('messages').store;
    let cursor =
      key === undefined
        ? await store.index('bySeq').openCursor(IDBKeyRange.upperBound(upper), 'prev')
        : await store
            .index('byConversationSeq')
            .openCursor(this.range(key, -Infinity, upper, false, false), 'prev');
    while (cursor && rows.length < SEARCH_SLICE) {
      if (!skip.has(cursor.value.id)) rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    return rows;
  }

  async mentions(
    contactId: string,
    { before, limit }: { before?: number; limit: number },
  ): Promise<Message[]> {
    const key = await this.cipher.blindId(contactId);
    const rows = await this.db.getAllFromIndex('messages', 'byMention', key);
    const messages = await this.fromRows(rows);
    return messages
      .filter((m) => !m.deleted && (before === undefined || (m.seq ?? 0) < before))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, limit);
  }

  async pinned(conversationId: ConversationId, limit: number): Promise<Message[]> {
    // Pins are rare and there's no index for them: one reverse scan of the conversation.
    const key = await this.cipher.blindId(conversationId);
    const rows: MessageRow[] = [];
    let cursor = await this.db
      .transaction('messages')
      .store.index('byConversationSeq')
      .openCursor(this.range(key, -Infinity, Infinity, false, false), 'prev');
    while (cursor) {
      rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    const messages = await this.fromRows(rows);
    return messages.filter((m) => m.pinned === true && !m.deleted).slice(0, limit);
  }

  async expired(now: number, limit: number): Promise<Message[]> {
    const rows = await this.db.getAllFromIndex(
      'messages',
      'byExpiresAt',
      IDBKeyRange.upperBound(now),
      limit,
    );
    return this.fromRows(rows);
  }

  async getReadCursors(): Promise<Map<ConversationId, number>> {
    const rows = await this.db.getAll('readCursors');
    const entries = await this.decodeBatch(
      rows,
      async (row) => {
        const plain = await this.cipher.decrypt(row.payload, row.id);
        return JSON.parse(utf8Decode(plain)) as { conversationId: ConversationId; seq: number };
      },
      'read cursor',
    );
    return new Map(entries.map((e) => [e.conversationId, e.seq]));
  }

  setReadCursor(conversationId: ConversationId, seq: number): Promise<void> {
    return this.mutate(async () => {
      const id = await this.cipher.blindId(conversationId);
      const payload = await this.cipher.encrypt(encodeJson({ conversationId, seq }), id);
      await this.db.put('readCursors', { id, payload });
    });
  }

  stageOutgoing(pending: Message, entry: OutboxEntry): Promise<void> {
    return this.mutate(async () => {
      const [messageRow, { row: outboxRow, attachmentRows }] = await Promise.all([
        this.toRow(pending),
        this.toOutboxRow(entry),
      ]);
      const tx = this.db.transaction(['messages', 'outbox', 'outboxAttachments'], 'readwrite');
      await tx.objectStore('messages').put(messageRow);
      await tx.objectStore('outbox').put(outboxRow);
      const attachments = tx.objectStore('outboxAttachments');
      for (const row of attachmentRows) await attachments.put(row);
      await tx.done;
    });
  }

  commitOutgoing(
    nonce: string,
    final: Message,
    merge: MergeFn,
    media: readonly SentMedia[] = [],
  ): Promise<UpsertResult> {
    return this.mutate(async () => {
      const [pendingId, finalKey] = await Promise.all([
        this.cipher.blindId(pendingMessageId(nonce)),
        this.cipher.blindId(final.id),
      ]);
      const existing = await this.tryFromRow(await this.db.get('messages', finalKey));
      let stored: Message;
      let created: boolean;
      if (existing) {
        stored = merge(existing, final);
        created = false;
      } else {
        const seq = await this.seqStateOnce();
        stored = { ...final, seq: final.seq ?? seq.max + 1 };
        created = true;
      }
      // A message already deleted for everyone has no attachments to keep a copy of.
      const keep = stored.deleted === true ? [] : media;
      if (stored.deleted === true) stored = withoutOriginals(stored, () => true);
      const finalRow = await this.toRow(stored);
      const tx = this.db.transaction(
        ['messages', 'meta', 'outbox', 'outboxAttachments'],
        'readwrite',
      );
      const messages = tx.objectStore('messages');
      const outboxRow = await tx.objectStore('outbox').get(nonce);
      await messages.delete(pendingId);
      await tx.objectStore('outbox').delete(nonce);
      const attachments = tx.objectStore('outboxAttachments');
      for (let i = 0; i < (outboxRow?.attachmentCount ?? 0); i++) {
        await attachments.delete(outboxAttachmentId(nonce, i));
      }
      await messages.put(finalRow);
      if (created) {
        const metaStore = tx.objectStore('meta');
        const seq = (await metaStore.get(SEQ_KEY)) ?? { key: SEQ_KEY, min: 1, max: 0 };
        await metaStore.put({
          ...seq,
          max: Math.max(seq.max, stored.seq as number),
          min: Math.min(seq.min, stored.seq as number),
        });
      }
      await tx.done;
      // The originals come after, one at a time and outside that transaction: a full disk
      // or a refused write must never undo recording a message that was already sent.
      const failed = await this.keepMedia(finalRow.conversationKey, keep);
      if (failed.size > 0) {
        stored = withoutOriginals(stored, (id) => failed.has(id));
        await this.db.put('messages', await this.toRow(stored));
      }
      return { message: stored, created };
    });
  }

  /** Stores kept originals, one at a time; returns the ids that could not be stored. */
  private async keepMedia(
    conversationKey: string,
    media: readonly SentMedia[],
  ): Promise<Set<string>> {
    const failed = new Set<string>();
    for (const item of media) {
      try {
        const id = await this.cipher.blindId(item.id);
        const payload = await this.cipher.encrypt(
          new Uint8Array(await item.data.arrayBuffer()),
          id,
        );
        await this.db.put('sentMedia', { id, conversationKey, payload });
      } catch {
        // The preview stands in; nothing about the file is logged.
        failed.add(item.id);
      }
    }
    return failed;
  }

  discardOutgoing(nonce: string): Promise<void> {
    return this.mutate(async () => {
      const pendingId = await this.cipher.blindId(pendingMessageId(nonce));
      const tx = this.db.transaction(['messages', 'outbox', 'outboxAttachments'], 'readwrite');
      const outboxRow = await tx.objectStore('outbox').get(nonce);
      await tx.objectStore('messages').delete(pendingId);
      await tx.objectStore('outbox').delete(nonce);
      const attachments = tx.objectStore('outboxAttachments');
      for (let i = 0; i < (outboxRow?.attachmentCount ?? 0); i++) {
        await attachments.delete(outboxAttachmentId(nonce, i));
      }
      await tx.done;
    });
  }

  /**
   * Splits an outbox entry into its JSON-safe row and the encrypted bytes of
   * each attachment (keyed by nonce+index, AAD bound to that same key — see
   * the file header on why crypto never happens inside an open transaction).
   */
  private async toOutboxRow(
    entry: OutboxEntry,
  ): Promise<{ row: OutboxRow; attachmentRows: OutboxAttachmentRow[] }> {
    const attachments = entry.input.attachments ?? [];
    const attachmentRows = await Promise.all(
      attachments.map(async (a, i): Promise<OutboxAttachmentRow> => {
        const id = outboxAttachmentId(entry.nonce, i);
        const bytes = new Uint8Array(await a.data.arrayBuffer());
        const payload = await this.cipher.encrypt(bytes, id);
        return { id, payload };
      }),
    );
    const stored: StoredSendInput = {
      ...entry.input,
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              fileName: a.fileName,
              contentType: a.contentType,
              ...(a.voiceNote ? { voiceNote: true } : {}),
            })),
          }
        : {}),
    };
    const payload = await this.cipher.encrypt(encodeJson({ input: stored }), entry.nonce);
    const row: OutboxRow = {
      nonce: entry.nonce,
      createdAt: entry.createdAt,
      attachmentCount: attachments.length,
      payload,
    };
    return { row, attachmentRows };
  }

  private async fromOutboxRow(row: OutboxRow): Promise<OutboxEntry> {
    const plain = await this.cipher.decrypt(row.payload, row.nonce);
    const { input } = JSON.parse(utf8Decode(plain)) as { input: StoredSendInput };
    const storedAttachments = input.attachments ?? [];
    if (row.attachmentCount === undefined) {
      // Pre-fix row (DB_VERSION < 3): any attachments were serialised as
      // `{}` and their bytes are gone; surface that rather than resending junk.
      const { attachments: _lost, ...rest } = input;
      return {
        nonce: row.nonce,
        createdAt: row.createdAt,
        input: { ...rest, attachments: [] },
        ...(storedAttachments.length > 0 ? { attachmentsLost: true } : {}),
      };
    }
    const attachments: OutgoingAttachment[] = [];
    let lost = false;
    for (let i = 0; i < storedAttachments.length; i++) {
      const meta = storedAttachments[i];
      if (!meta) continue;
      try {
        const id = outboxAttachmentId(row.nonce, i);
        const attRow = await this.db.get('outboxAttachments', id);
        if (!attRow) throw new Error('missing outbox attachment row');
        const bytes = await this.cipher.decrypt(attRow.payload, id);
        attachments.push({
          fileName: meta.fileName,
          contentType: meta.contentType,
          data: new File([new Uint8Array(bytes)], meta.fileName, { type: meta.contentType }),
          ...(meta.voiceNote ? { voiceNote: true } : {}),
        });
      } catch {
        lost = true;
      }
    }
    const resultInput: SendInput = { ...input, attachments };
    return {
      nonce: row.nonce,
      createdAt: row.createdAt,
      input: resultInput,
      ...(lost ? { attachmentsLost: true } : {}),
    };
  }

  putOutbox(entry: OutboxEntry): Promise<void> {
    return this.mutate(async () => {
      const { row, attachmentRows } = await this.toOutboxRow(entry);
      const tx = this.db.transaction(['outbox', 'outboxAttachments'], 'readwrite');
      const previous = await tx.objectStore('outbox').get(entry.nonce);
      await tx.objectStore('outbox').put(row);
      const attachments = tx.objectStore('outboxAttachments');
      // Replace any previous attachment bytes for this nonce: edits only
      // rewrite body/ranges today, but this stays correct if that changes.
      for (let i = 0; i < (previous?.attachmentCount ?? 0); i++) {
        await attachments.delete(outboxAttachmentId(entry.nonce, i));
      }
      for (const attRow of attachmentRows) await attachments.put(attRow);
      await tx.done;
    });
  }

  deleteOutbox(nonce: string): Promise<void> {
    return this.mutate(async () => {
      const tx = this.db.transaction(['outbox', 'outboxAttachments'], 'readwrite');
      const outboxRow = await tx.objectStore('outbox').get(nonce);
      await tx.objectStore('outbox').delete(nonce);
      const attachments = tx.objectStore('outboxAttachments');
      for (let i = 0; i < (outboxRow?.attachmentCount ?? 0); i++) {
        await attachments.delete(outboxAttachmentId(nonce, i));
      }
      await tx.done;
    });
  }

  /**
   * The restorable outbox entries. One that can't be decrypted is skipped and
   * kept on disk, never deleted: the outbox is keyed by plain nonce, so a
   * wrong key (not just one corrupt row) makes every entry unreadable, and
   * the entries come back once the right key does. Logs a count only.
   */
  async listOutbox(): Promise<OutboxEntry[]> {
    const rows = await this.db.getAll('outbox');
    const entries = await this.decodeBatch(rows, (row) => this.fromOutboxRow(row), 'outbox');
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  deleteConversation(conversationId: ConversationId): Promise<void> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(conversationId);
      // Queued sends go with the conversation, or they would come back as
      // failed messages on the next start. The outbox is only readable
      // decrypted, so the matching entries are found before the transaction.
      const outboxRows = await this.db.getAll('outbox');
      const queued = (
        await Promise.all(
          outboxRows.map(async (row) => {
            try {
              const plain = await this.cipher.decrypt(row.payload, row.nonce);
              const { input } = JSON.parse(utf8Decode(plain)) as { input: StoredSendInput };
              return input.conversationId === conversationId ? row : undefined;
            } catch {
              return undefined;
            }
          }),
        )
      ).filter((row): row is OutboxRow => row !== undefined);
      const tx = this.db.transaction(
        ['messages', 'readCursors', 'sentMedia', 'outbox', 'outboxAttachments'],
        'readwrite',
      );
      for (const row of queued) {
        await tx.objectStore('outbox').delete(row.nonce);
        for (let i = 0; i < (row.attachmentCount ?? 0); i++) {
          await tx.objectStore('outboxAttachments').delete(outboxAttachmentId(row.nonce, i));
        }
      }
      const media = tx.objectStore('sentMedia').index('byConversation');
      let mediaCursor = await media.openKeyCursor(IDBKeyRange.only(key));
      while (mediaCursor) {
        await tx.objectStore('sentMedia').delete(mediaCursor.primaryKey);
        mediaCursor = await mediaCursor.continue();
      }
      const index = tx.objectStore('messages').index('byConversationSeq');
      let cursor = await index.openCursor(this.range(key, -Infinity, Infinity, false, false));
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await Promise.all([tx.objectStore('readCursors').delete(key), tx.done]);
    });
  }

  clear(): Promise<void> {
    return this.mutate(async () => {
      const tx = this.db.transaction(
        ['messages', 'readCursors', 'meta', 'outbox', 'outboxAttachments', 'sentMedia'],
        'readwrite',
      );
      await Promise.all([
        tx.objectStore('sentMedia').clear(),
        tx.objectStore('messages').clear(),
        tx.objectStore('readCursors').clear(),
        tx.objectStore('meta').clear(),
        tx.objectStore('outbox').clear(),
        tx.objectStore('outboxAttachments').clear(),
        tx.done,
      ]);
    });
  }
}
