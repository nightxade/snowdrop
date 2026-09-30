/**
 * In-memory MessageRepository: used by tests, by the demo (whose world is
 * regenerated every launch), and as a fallback when IndexedDB is unavailable.
 */
import type { ConversationId, Message, MessageId } from '@/core/domain';
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

const bySeq = (a: Message, b: Message): number => (a.seq ?? 0) - (b.seq ?? 0);
const clone = (m: Message): Message => structuredClone(m);

export class MemoryMessageRepository implements MessageRepository {
  private readonly messages = new Map<MessageId, Message>();
  /** Per-conversation ids kept sorted by seq. */
  private readonly timelines = new Map<ConversationId, Message[]>();
  private readonly cursors = new Map<ConversationId, number>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private maxSeq = 0;
  private minSeq = 1;

  get(id: MessageId): Promise<Message | undefined> {
    const m = this.messages.get(id);
    return Promise.resolve(m ? clone(m) : undefined);
  }

  private store(message: Message): void {
    const previous = this.messages.get(message.id);
    const timeline = this.timelines.get(message.conversationId) ?? [];
    if (previous) timeline.splice(timeline.indexOf(previous), 1);
    // Binary insertion keeps the timeline sorted by seq.
    let lo = 0;
    let hi = timeline.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bySeq(timeline[mid] as Message, message) <= 0) lo = mid + 1;
      else hi = mid;
    }
    timeline.splice(lo, 0, message);
    this.timelines.set(message.conversationId, timeline);
    this.messages.set(message.id, message);
    if (message.seq !== undefined) {
      this.maxSeq = Math.max(this.maxSeq, message.seq);
      this.minSeq = Math.min(this.minSeq, message.seq);
    }
  }

  upsert(message: Message, merge: MergeFn): Promise<UpsertResult> {
    const existing = this.messages.get(message.id);
    if (existing) {
      const merged = clone(merge(clone(existing), clone(message)));
      this.store(merged);
      return Promise.resolve({ message: clone(merged), created: false });
    }
    const stored = clone({ ...message, seq: message.seq ?? ++this.maxSeq });
    this.store(stored);
    return Promise.resolve({ message: clone(stored), created: true });
  }

  upsertMany(
    messages: readonly Message[],
    { backfill, merge }: { backfill: boolean; merge: MergeFn },
  ): Promise<Message[]> {
    const fresh = messages.filter((m) => !this.messages.has(m.id));
    // Backfill seqs count down from below the current minimum, preserving input order.
    let next = backfill ? this.minSeq - fresh.length : this.maxSeq + 1;
    const out: Message[] = [];
    for (const m of messages) {
      const existing = this.messages.get(m.id);
      const stored = existing
        ? clone(merge(clone(existing), clone(m)))
        : clone({ ...m, seq: m.seq ?? next++ });
      this.store(stored);
      out.push(clone(stored));
    }
    return Promise.resolve(out);
  }

  update(id: MessageId, fn: (message: Message) => Message): Promise<Message | undefined> {
    const current = this.messages.get(id);
    if (!current) return Promise.resolve(undefined);
    const updated = fn(clone(current));
    // Updates never move a message in the timeline.
    const next = clone(current.seq === undefined ? updated : { ...updated, seq: current.seq });
    this.store(next);
    return Promise.resolve(clone(next));
  }

  delete(id: MessageId): Promise<void> {
    const m = this.messages.get(id);
    if (m) {
      const timeline = this.timelines.get(m.conversationId);
      timeline?.splice(timeline.indexOf(m), 1);
      this.messages.delete(id);
    }
    return Promise.resolve();
  }

  allocateSeq(): Promise<number> {
    return Promise.resolve(++this.maxSeq);
  }

  page(conversationId: ConversationId, { before, after, limit }: PageQuery): Promise<Message[]> {
    const timeline = this.timelines.get(conversationId) ?? [];
    let out: Message[];
    if (after !== undefined) {
      out = timeline.filter((m) => (m.seq ?? 0) > after).slice(0, limit);
    } else {
      const eligible =
        before === undefined ? timeline : timeline.filter((m) => (m.seq ?? 0) < before);
      out = eligible.slice(Math.max(0, eligible.length - limit));
    }
    return Promise.resolve(out.map(clone));
  }

  listAfter(conversationId: ConversationId, after: number): Promise<Message[]> {
    const timeline = this.timelines.get(conversationId) ?? [];
    return Promise.resolve(timeline.filter((m) => (m.seq ?? 0) > after).map(clone));
  }

  latest(conversationId: ConversationId): Promise<Message | undefined> {
    const last = this.timelines.get(conversationId)?.at(-1);
    return Promise.resolve(last ? clone(last) : undefined);
  }

  count(conversationId: ConversationId): Promise<number> {
    return Promise.resolve(this.timelines.get(conversationId)?.length ?? 0);
  }

  search(text: string, { conversationId, limit }: SearchQuery): Promise<Message[]> {
    const terms = searchTerms(text);
    if (terms.length === 0) return Promise.resolve([]);
    const pool =
      conversationId === undefined
        ? [...this.messages.values()]
        : [...(this.timelines.get(conversationId) ?? [])];
    return Promise.resolve(
      pool
        .filter((m) => matchesSearch(m, terms))
        .sort((a, b) => bySeq(b, a))
        .slice(0, limit)
        .map(clone),
    );
  }

  mentions(
    contactId: string,
    { before, limit }: { before?: number; limit: number },
  ): Promise<Message[]> {
    return Promise.resolve(
      [...this.messages.values()]
        .filter(
          (m) =>
            !m.deleted &&
            (before === undefined || (m.seq ?? 0) < before) &&
            m.ranges.some((r) => r.mentionId === contactId),
        )
        .sort((a, b) => bySeq(b, a))
        .slice(0, limit)
        .map(clone),
    );
  }

  expired(now: number, limit: number): Promise<Message[]> {
    return Promise.resolve(
      [...this.messages.values()]
        .filter((m) => m.expiresAt !== undefined && m.expiresAt <= now)
        .slice(0, limit)
        .map(clone),
    );
  }

  getReadCursors(): Promise<Map<ConversationId, number>> {
    return Promise.resolve(new Map(this.cursors));
  }

  setReadCursor(conversationId: ConversationId, seq: number): Promise<void> {
    this.cursors.set(conversationId, seq);
    return Promise.resolve();
  }

  putOutbox(entry: OutboxEntry): Promise<void> {
    // Not cloned: SendInput carries Blobs, which are immutable anyway.
    this.outbox.set(entry.nonce, entry);
    return Promise.resolve();
  }

  deleteOutbox(nonce: string): Promise<void> {
    this.outbox.delete(nonce);
    return Promise.resolve();
  }

  listOutbox(): Promise<OutboxEntry[]> {
    return Promise.resolve([...this.outbox.values()].sort((a, b) => a.createdAt - b.createdAt));
  }

  clear(): Promise<void> {
    this.messages.clear();
    this.timelines.clear();
    this.cursors.clear();
    this.outbox.clear();
    this.maxSeq = 0;
    this.minSeq = 1;
    return Promise.resolve();
  }
}
