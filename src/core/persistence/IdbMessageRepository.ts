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
  mentionsOf,
  pendingMessageId,
  type ConversationId,
  type Message,
  type MessageId,
} from '@/core/domain';
import { createLogger } from '@/core/lib';
import { plaintextCipher, utf8Decode, utf8Encode, type RecordCipher } from './crypto';
import {
  matchesSearch,
  searchTerms,
  type MergeFn,
  type MessageRepository,
  type OutboxEntry,
  type PageQuery,
  type SearchQuery,
  type UpsertResult,
} from './MessageRepository';

const DB_VERSION = 3;
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
  /** `${nonce}:${index}` — the primary key, and the AAD binding it to that slot. */
  id: string;
  fileName: string;
  contentType: string;
  /** AES-GCM of the raw attachment bytes, AAD = `id`. */
  payload: Uint8Array;
}

/** `SendInput` as actually stored: each attachment's Blob replaced by its metadata. */
type StoredSendInput = Omit<SendInput, 'attachments'> & {
  attachments?: { fileName: string; contentType: string }[];
};

interface SnowdropDB extends DBSchema {
  messages: {
    key: string;
    value: MessageRow;
    indexes: {
      byConversationSeq: [string, number];
      byMention: string;
      byExpiresAt: number;
    };
  };
  readCursors: { key: string; value: CursorRow };
  meta: { key: string; value: SeqState };
  outbox: { key: string; value: OutboxRow };
  outboxAttachments: { key: string; value: OutboxAttachmentRow };
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
      upgrade(database, oldVersion) {
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
      },
    });
    return new IdbMessageRepository(db, cipher);
  }

  close(): void {
    this.db.close();
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
      const existingRow = await this.db.get('messages', key);
      if (existingRow) {
        const existing = await this.fromRow(existingRow);
        const merged = merge(existing, message);
        await this.db.put('messages', await this.toRow(merged));
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
      const existing = await Promise.all(
        existingRows.map((row) => (row ? this.fromRow(row) : Promise.resolve(undefined))),
      );
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
      const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
      await Promise.all([
        ...rows.map((row) => tx.objectStore('messages').put(row)),
        tx.objectStore('meta').put({ key: SEQ_KEY, min, max }),
        tx.done,
      ]);
      return out;
    });
  }

  update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(id);
      const currentRow = await this.db.get('messages', key);
      if (!currentRow) return undefined;
      const before = await this.fromRow(currentRow);
      // Updates never move a message in the timeline.
      const next: Message =
        before.seq === undefined ? fn(before) : { ...fn(before), seq: before.seq };
      await this.db.put('messages', await this.toRow(next));
      return next;
    });
  }

  delete(id: MessageId): Promise<void> {
    return this.mutate(async () => {
      const key = await this.cipher.blindId(id);
      await this.db.delete('messages', key);
    });
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

  async search(text: string, { conversationId, limit }: SearchQuery): Promise<Message[]> {
    const terms = searchTerms(text);
    if (terms.length === 0) return [];
    const key =
      conversationId === undefined ? undefined : await this.cipher.blindId(conversationId);
    const rows: MessageRow[] = [];
    const tx = this.db.transaction('messages');
    let cursor =
      key === undefined
        ? await tx.store.openCursor()
        : await tx.store
            .index('byConversationSeq')
            .openCursor(this.range(key, -Infinity, Infinity, false, false), 'prev');
    // Can't filter by body match until it's decrypted, so (unlike the
    // unencrypted version) there's no early break here per conversation —
    // just a bound on the whole table scan, same as the cross-conversation case.
    while (cursor) {
      rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    const messages = await this.fromRows(rows);
    return messages
      .filter((m) => matchesSearch(m, terms))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, limit);
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

  commitOutgoing(nonce: string, final: Message, merge: MergeFn): Promise<UpsertResult> {
    return this.mutate(async () => {
      const [pendingId, finalKey] = await Promise.all([
        this.cipher.blindId(pendingMessageId(nonce)),
        this.cipher.blindId(final.id),
      ]);
      const existingRow = await this.db.get('messages', finalKey);
      let stored: Message;
      let created: boolean;
      if (existingRow) {
        const existing = await this.fromRow(existingRow);
        stored = merge(existing, final);
        created = false;
      } else {
        const seq = await this.seqStateOnce();
        stored = { ...final, seq: final.seq ?? seq.max + 1 };
        created = true;
      }
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
      return { message: stored, created };
    });
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
        return { id, fileName: a.fileName, contentType: a.contentType, payload };
      }),
    );
    const stored: StoredSendInput = {
      ...entry.input,
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              fileName: a.fileName,
              contentType: a.contentType,
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

  async listOutbox(): Promise<OutboxEntry[]> {
    const rows = await this.db.getAll('outbox');
    const entries = await this.decodeBatch(rows, (row) => this.fromOutboxRow(row), 'outbox');
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  clear(): Promise<void> {
    return this.mutate(async () => {
      const tx = this.db.transaction(
        ['messages', 'readCursors', 'meta', 'outbox', 'outboxAttachments'],
        'readwrite',
      );
      await Promise.all([
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
