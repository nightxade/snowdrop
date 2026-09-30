/**
 * IndexedDB-backed MessageRepository.
 *
 * Messages are keyed by MessageId (author:sentAt — Signal's identity) and
 * indexed by [conversationId, sentAt] so paging a conversation is a single
 * bounded cursor walk, independent of total history size.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConversationId, Message, MessageId } from '@/core/domain';
import { toStored, type MessageRepository, type PageQuery } from './MessageRepository';

const DB_VERSION = 1;

interface HearthDB extends DBSchema {
  messages: {
    key: string;
    value: Message;
    indexes: { byConversationSentAt: [string, number] };
  };
  readCursors: {
    key: string;
    value: { conversationId: string; sentAt: number };
  };
}

export class IdbMessageRepository implements MessageRepository {
  private constructor(private readonly db: IDBPDatabase<HearthDB>) {}

  static async open(name = 'hearth'): Promise<IdbMessageRepository> {
    const db = await openDB<HearthDB>(name, DB_VERSION, {
      upgrade(database, oldVersion) {
        // Versioned, additive migrations: each step upgrades from the previous version.
        if (oldVersion < 1) {
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('byConversationSentAt', ['conversationId', 'sentAt']);
          database.createObjectStore('readCursors', { keyPath: 'conversationId' });
        }
      },
    });
    return new IdbMessageRepository(db);
  }

  close(): void {
    this.db.close();
  }

  get(id: MessageId): Promise<Message | undefined> {
    return this.db.get('messages', id);
  }

  async put(message: Message): Promise<void> {
    await this.db.put('messages', toStored(message));
  }

  async putMany(messages: readonly Message[]): Promise<void> {
    const tx = this.db.transaction('messages', 'readwrite');
    await Promise.all([...messages.map((m) => tx.store.put(toStored(m))), tx.done]);
  }

  async update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    const tx = this.db.transaction('messages', 'readwrite');
    const current = await tx.store.get(id);
    if (!current) {
      await tx.done;
      return undefined;
    }
    const next = toStored(fn(current));
    await tx.store.put(next);
    await tx.done;
    return next;
  }

  async delete(id: MessageId): Promise<void> {
    await this.db.delete('messages', id);
  }

  async page(conversationId: ConversationId, { before, limit }: PageQuery): Promise<Message[]> {
    const range = IDBKeyRange.bound(
      [conversationId, -Infinity],
      [conversationId, before ?? Infinity],
      false,
      true,
    );
    const out: Message[] = [];
    let cursor = await this.db
      .transaction('messages')
      .store.index('byConversationSentAt')
      .openCursor(range, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out.reverse();
  }

  listAfter(conversationId: ConversationId, after: number): Promise<Message[]> {
    const range = IDBKeyRange.bound(
      [conversationId, after],
      [conversationId, Infinity],
      true,
      false,
    );
    return this.db.getAllFromIndex('messages', 'byConversationSentAt', range);
  }

  count(conversationId: ConversationId): Promise<number> {
    const range = IDBKeyRange.bound([conversationId, -Infinity], [conversationId, Infinity]);
    return this.db.countFromIndex('messages', 'byConversationSentAt', range);
  }

  async getReadCursors(): Promise<Map<ConversationId, number>> {
    const rows = await this.db.getAll('readCursors');
    return new Map(rows.map((r) => [r.conversationId as ConversationId, r.sentAt]));
  }

  async setReadCursor(conversationId: ConversationId, sentAt: number): Promise<void> {
    await this.db.put('readCursors', { conversationId, sentAt });
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(['messages', 'readCursors'], 'readwrite');
    await Promise.all([
      tx.objectStore('messages').clear(),
      tx.objectStore('readCursors').clear(),
      tx.done,
    ]);
  }
}
