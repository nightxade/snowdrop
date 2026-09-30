/**
 * In-memory MessageRepository: used by tests, and as a fallback when
 * IndexedDB is unavailable (e.g. some private browsing modes).
 */
import type { ConversationId, Message, MessageId } from '@/core/domain';
import { toStored, type MessageRepository, type PageQuery } from './MessageRepository';

export class MemoryMessageRepository implements MessageRepository {
  private readonly messages = new Map<MessageId, Message>();
  private readonly cursors = new Map<ConversationId, number>();

  get(id: MessageId): Promise<Message | undefined> {
    const m = this.messages.get(id);
    return Promise.resolve(m ? structuredClone(m) : undefined);
  }

  put(message: Message): Promise<void> {
    this.messages.set(message.id, structuredClone(toStored(message)));
    return Promise.resolve();
  }

  async putMany(messages: readonly Message[]): Promise<void> {
    for (const m of messages) await this.put(m);
  }

  async update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    const current = this.messages.get(id);
    if (!current) return undefined;
    const next = toStored(fn(structuredClone(current)));
    await this.put(next);
    return structuredClone(next);
  }

  delete(id: MessageId): Promise<void> {
    this.messages.delete(id);
    return Promise.resolve();
  }

  private sorted(conversationId: ConversationId): Message[] {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  page(conversationId: ConversationId, { before, limit }: PageQuery): Promise<Message[]> {
    const all = this.sorted(conversationId).filter(
      (m) => before === undefined || m.sentAt < before,
    );
    return Promise.resolve(
      all.slice(Math.max(0, all.length - limit)).map((m) => structuredClone(m)),
    );
  }

  listAfter(conversationId: ConversationId, after: number): Promise<Message[]> {
    return Promise.resolve(
      this.sorted(conversationId)
        .filter((m) => m.sentAt > after)
        .map((m) => structuredClone(m)),
    );
  }

  count(conversationId: ConversationId): Promise<number> {
    return Promise.resolve(this.sorted(conversationId).length);
  }

  getReadCursors(): Promise<Map<ConversationId, number>> {
    return Promise.resolve(new Map(this.cursors));
  }

  setReadCursor(conversationId: ConversationId, sentAt: number): Promise<void> {
    this.cursors.set(conversationId, sentAt);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.messages.clear();
    this.cursors.clear();
    return Promise.resolve();
  }
}
