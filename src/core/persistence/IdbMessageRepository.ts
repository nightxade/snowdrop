/**
 * IndexedDB-backed MessageRepository.
 *
 * Messages are keyed by MessageId (author:sentAt — Signal's identity) and
 * indexed by [conversationId, seq] so paging a conversation is one bounded
 * cursor walk regardless of history size. Mentions (multiEntry) and
 * expiresAt are indexed for the inbox and the disappearing-message purge.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  asConversationId,
  pendingMessageId,
  type ConversationId,
  type Message,
  type MessageId,
} from '@/core/domain';
import {
  fromStored,
  matchesSearch,
  searchTerms,
  toStored,
  type MergeFn,
  type MessageRepository,
  type OutboxEntry,
  type PageQuery,
  type SearchQuery,
  type StoredMessage,
  type UpsertResult,
} from './MessageRepository';

const DB_VERSION = 1;
const SEQ_KEY = 'seq';

interface SeqState {
  key: typeof SEQ_KEY;
  min: number;
  max: number;
}

interface HearthDB extends DBSchema {
  messages: {
    key: string;
    value: StoredMessage;
    indexes: {
      byConversationSeq: [string, number];
      byMention: string;
      byExpiresAt: number;
    };
  };
  readCursors: { key: string; value: { conversationId: string; seq: number } };
  meta: { key: string; value: SeqState };
  outbox: { key: string; value: OutboxEntry };
}

type RwTx = IDBPTransaction<HearthDB, ('messages' | 'meta')[], 'readwrite'>;

export class IdbMessageRepository implements MessageRepository {
  private constructor(private readonly db: IDBPDatabase<HearthDB>) {}

  static async open(name = 'hearth'): Promise<IdbMessageRepository> {
    const db = await openDB<HearthDB>(name, DB_VERSION, {
      upgrade(database, oldVersion) {
        // Versioned, additive migrations: each step upgrades from the previous version.
        if (oldVersion < 1) {
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('byConversationSeq', ['conversationId', 'seq']);
          messages.createIndex('byMention', 'mentionIds', { multiEntry: true });
          messages.createIndex('byExpiresAt', 'expiresAt');
          database.createObjectStore('readCursors', { keyPath: 'conversationId' });
          database.createObjectStore('meta', { keyPath: 'key' });
          database.createObjectStore('outbox', { keyPath: 'nonce' });
        }
      },
    });
    return new IdbMessageRepository(db);
  }

  close(): void {
    this.db.close();
  }

  private async seqState(tx: RwTx): Promise<SeqState> {
    return (await tx.objectStore('meta').get(SEQ_KEY)) ?? { key: SEQ_KEY, min: 1, max: 0 };
  }

  async get(id: MessageId): Promise<Message | undefined> {
    const stored = await this.db.get('messages', id);
    return stored ? fromStored(stored) : undefined;
  }

  async upsert(message: Message, merge: MergeFn): Promise<UpsertResult> {
    const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
    const store = tx.objectStore('messages');
    const existing = await store.get(message.id);
    let result: UpsertResult;
    if (existing) {
      const merged = merge(fromStored(existing), message);
      await store.put(toStored(merged));
      result = { message: merged, created: false };
    } else {
      const seq = await this.seqState(tx);
      const stored = { ...message, seq: message.seq ?? seq.max + 1 };
      await tx
        .objectStore('meta')
        .put({ ...seq, max: Math.max(seq.max, stored.seq), min: Math.min(seq.min, stored.seq) });
      await store.put(toStored(stored));
      result = { message: stored, created: true };
    }
    await tx.done;
    return result;
  }

  async upsertMany(
    messages: readonly Message[],
    { backfill, merge }: { backfill: boolean; merge: MergeFn },
  ): Promise<Message[]> {
    const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
    const store = tx.objectStore('messages');
    const existing = await Promise.all(messages.map((m) => store.get(m.id)));
    const freshCount = existing.filter((e) => e === undefined).length;
    const seq = await this.seqState(tx);
    let next = backfill ? seq.min - freshCount : seq.max + 1;
    const out: Message[] = [];
    let min = seq.min;
    let max = seq.max;
    for (const [i, m] of messages.entries()) {
      const found = existing[i];
      const stored = found ? merge(fromStored(found), m) : { ...m, seq: m.seq ?? next++ };
      if (stored.seq !== undefined) {
        min = Math.min(min, stored.seq);
        max = Math.max(max, stored.seq);
      }
      out.push(stored);
    }
    await Promise.all([
      ...out.map((m) => store.put(toStored(m))),
      tx.objectStore('meta').put({ key: SEQ_KEY, min, max }),
    ]);
    await tx.done;
    return out;
  }

  async update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    const tx = this.db.transaction('messages', 'readwrite');
    const current = await tx.store.get(id);
    if (!current) {
      await tx.done;
      return undefined;
    }
    const before = fromStored(current);
    // Updates never move a message in the timeline.
    const next: Message =
      before.seq === undefined ? fn(before) : { ...fn(before), seq: before.seq };
    await tx.store.put(toStored(next));
    await tx.done;
    return next;
  }

  async delete(id: MessageId): Promise<void> {
    await this.db.delete('messages', id);
  }

  async allocateSeq(): Promise<number> {
    const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
    const seq = await this.seqState(tx);
    const next = seq.max + 1;
    await tx.objectStore('meta').put({ ...seq, max: next });
    await tx.done;
    return next;
  }

  private range(
    conversationId: ConversationId,
    lower: number,
    upper: number,
    lowerOpen: boolean,
    upperOpen: boolean,
  ): IDBKeyRange {
    return IDBKeyRange.bound(
      [conversationId, lower],
      [conversationId, upper],
      lowerOpen,
      upperOpen,
    );
  }

  async page(
    conversationId: ConversationId,
    { before, after, limit }: PageQuery,
  ): Promise<Message[]> {
    const index = this.db.transaction('messages').store.index('byConversationSeq');
    const out: Message[] = [];
    if (after !== undefined) {
      let cursor = await index.openCursor(
        this.range(conversationId, after, Infinity, true, false),
        'next',
      );
      while (cursor && out.length < limit) {
        out.push(fromStored(cursor.value));
        cursor = await cursor.continue();
      }
      return out;
    }
    let cursor = await index.openCursor(
      this.range(conversationId, -Infinity, before ?? Infinity, false, before !== undefined),
      'prev',
    );
    while (cursor && out.length < limit) {
      out.push(fromStored(cursor.value));
      cursor = await cursor.continue();
    }
    return out.reverse();
  }

  async listAfter(conversationId: ConversationId, after: number): Promise<Message[]> {
    const rows = await this.db.getAllFromIndex(
      'messages',
      'byConversationSeq',
      this.range(conversationId, after, Infinity, true, false),
    );
    return rows.map(fromStored);
  }

  async latest(conversationId: ConversationId): Promise<Message | undefined> {
    const [last] = await this.page(conversationId, { limit: 1 });
    return last;
  }

  count(conversationId: ConversationId): Promise<number> {
    return this.db.countFromIndex(
      'messages',
      'byConversationSeq',
      this.range(conversationId, -Infinity, Infinity, false, false),
    );
  }

  async search(text: string, { conversationId, limit }: SearchQuery): Promise<Message[]> {
    const terms = searchTerms(text);
    if (terms.length === 0) return [];
    const out: Message[] = [];
    const tx = this.db.transaction('messages');
    let cursor =
      conversationId === undefined
        ? await tx.store.openCursor()
        : await tx.store
            .index('byConversationSeq')
            .openCursor(this.range(conversationId, -Infinity, Infinity, false, false), 'prev');
    while (cursor) {
      const m = fromStored(cursor.value);
      if (matchesSearch(m, terms)) out.push(m);
      if (conversationId !== undefined && out.length >= limit) break;
      cursor = await cursor.continue();
    }
    return out.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, limit);
  }

  async mentions(
    contactId: string,
    { before, limit }: { before?: number; limit: number },
  ): Promise<Message[]> {
    const rows = await this.db.getAllFromIndex('messages', 'byMention', contactId);
    return rows
      .map(fromStored)
      .filter((m) => !m.deleted && (before === undefined || (m.seq ?? 0) < before))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, limit);
  }

  async pinned(conversationId: ConversationId, limit: number): Promise<Message[]> {
    // Pins are rare and there's no index for them: one reverse scan of the conversation.
    const out: Message[] = [];
    let cursor = await this.db
      .transaction('messages')
      .store.index('byConversationSeq')
      .openCursor(this.range(conversationId, -Infinity, Infinity, false, false), 'prev');
    while (cursor && out.length < limit) {
      const m = fromStored(cursor.value);
      if (m.pinned === true && !m.deleted) out.push(m);
      cursor = await cursor.continue();
    }
    return out;
  }

  async expired(now: number, limit: number): Promise<Message[]> {
    const rows = await this.db.getAllFromIndex(
      'messages',
      'byExpiresAt',
      IDBKeyRange.upperBound(now),
      limit,
    );
    return rows.map(fromStored);
  }

  async getReadCursors(): Promise<Map<ConversationId, number>> {
    const rows = await this.db.getAll('readCursors');
    return new Map(
      rows.flatMap((r) => {
        const id = asConversationId(r.conversationId);
        return id ? [[id, r.seq] as const] : [];
      }),
    );
  }

  async setReadCursor(conversationId: ConversationId, seq: number): Promise<void> {
    await this.db.put('readCursors', { conversationId, seq });
  }

  async stageOutgoing(pending: Message, entry: OutboxEntry): Promise<void> {
    const tx = this.db.transaction(['messages', 'outbox'], 'readwrite');
    await Promise.all([
      tx.objectStore('messages').put(toStored(pending)),
      tx.objectStore('outbox').put(entry),
      tx.done,
    ]);
  }

  async commitOutgoing(nonce: string, final: Message, merge: MergeFn): Promise<UpsertResult> {
    const tx = this.db.transaction(['messages', 'meta', 'outbox'], 'readwrite');
    const messages = tx.objectStore('messages');
    await messages.delete(pendingMessageId(nonce));
    await tx.objectStore('outbox').delete(nonce);
    const existing = await messages.get(final.id);
    let result: UpsertResult;
    if (existing) {
      const merged = merge(fromStored(existing), final);
      await messages.put(toStored(merged));
      result = { message: merged, created: false };
    } else {
      const meta = tx.objectStore('meta');
      const seq = (await meta.get(SEQ_KEY)) ?? { key: SEQ_KEY, min: 1, max: 0 };
      const stored = { ...final, seq: final.seq ?? seq.max + 1 };
      await meta.put({
        ...seq,
        max: Math.max(seq.max, stored.seq),
        min: Math.min(seq.min, stored.seq),
      });
      await messages.put(toStored(stored));
      result = { message: stored, created: true };
    }
    await tx.done;
    return result;
  }

  async discardOutgoing(nonce: string): Promise<void> {
    const tx = this.db.transaction(['messages', 'outbox'], 'readwrite');
    await Promise.all([
      tx.objectStore('messages').delete(pendingMessageId(nonce)),
      tx.objectStore('outbox').delete(nonce),
      tx.done,
    ]);
  }

  async putOutbox(entry: OutboxEntry): Promise<void> {
    await this.db.put('outbox', entry);
  }

  async deleteOutbox(nonce: string): Promise<void> {
    await this.db.delete('outbox', nonce);
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    const rows = await this.db.getAll('outbox');
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(['messages', 'readCursors', 'meta', 'outbox'], 'readwrite');
    await Promise.all([
      tx.objectStore('messages').clear(),
      tx.objectStore('readCursors').clear(),
      tx.objectStore('meta').clear(),
      tx.objectStore('outbox').clear(),
      tx.done,
    ]);
  }
}
