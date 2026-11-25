/**
 * In-memory MessageRepository: used by tests, by the demo (whose world is
 * regenerated every launch), and as a fallback when IndexedDB is unavailable.
 */
import {
  hasGalleryItems,
  pendingMessageId,
  type ConversationId,
  type GalleryKind,
  type Message,
  type MessageId,
} from '@/core/domain';
import {
  droppedOriginals,
  matchesSearch,
  newestSentFirst,
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

const bySeq = (a: Message, b: Message): number => (a.seq ?? 0) - (b.seq ?? 0);
const clone = (m: Message): Message => structuredClone(m);

/** A rejection for an aborted signal, so the memory repository fails like the others (undefined if not aborted). */
function abortion(signal: AbortSignal | undefined): Promise<never> | undefined {
  if (!signal?.aborted) return undefined;
  return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
}

export class MemoryMessageRepository implements MessageRepository {
  private readonly messages = new Map<MessageId, Message>();
  /** Per-conversation ids kept sorted by seq. */
  private readonly timelines = new Map<ConversationId, Message[]>();
  private readonly cursors = new Map<ConversationId, number>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly sentMedia = new Map<string, { conversationId: ConversationId; data: Blob }>();
  private maxSeq = 0;
  private minSeq = 1;

  get(id: MessageId): Promise<Message | undefined> {
    const m = this.messages.get(id);
    return Promise.resolve(m ? clone(m) : undefined);
  }

  pendingHistoryTimers(): Promise<Message[]> {
    return Promise.resolve(
      [...this.messages.values()]
        .filter(
          (message) =>
            message.historyCursor && message.expiresAfterReadMs && message.expiresAt === undefined,
        )
        .map(clone),
    );
  }

  private store(message: Message): void {
    const previous = this.messages.get(message.id);
    for (const id of droppedOriginals(previous, message)) this.sentMedia.delete(id);
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
      for (const id of droppedOriginals(m, undefined)) this.sentMedia.delete(id);
      const timeline = this.timelines.get(m.conversationId);
      timeline?.splice(timeline.indexOf(m), 1);
      this.messages.delete(id);
    }
    return Promise.resolve();
  }

  deleteConversation(conversationId: ConversationId): Promise<void> {
    for (const m of this.timelines.get(conversationId) ?? []) this.messages.delete(m.id);
    this.timelines.delete(conversationId);
    this.cursors.delete(conversationId);
    for (const [id, media] of this.sentMedia) {
      if (media.conversationId === conversationId) this.sentMedia.delete(id);
    }
    for (const [nonce, entry] of this.outbox) {
      if (entry.input.conversationId === conversationId) this.outbox.delete(nonce);
    }
    return Promise.resolve();
  }

  flush(): Promise<void> {
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

  search(
    text: string,
    { conversationId, limit, signal, nameFor }: SearchQuery,
  ): Promise<Message[]> {
    if (signal?.aborted) return Promise.reject(new DOMException('Search aborted', 'AbortError'));
    const terms = searchTerms(text);
    if (terms.length === 0) return Promise.resolve([]);
    const pool =
      conversationId === undefined
        ? [...this.messages.values()]
        : [...(this.timelines.get(conversationId) ?? [])];
    return Promise.resolve(
      pool
        .filter((m) => matchesSearch(m, terms, nameFor))
        .sort(conversationId === undefined ? newestSentFirst : (a, b) => bySeq(b, a))
        .slice(0, limit)
        .map(clone),
    );
  }

  media(
    conversationId: ConversationId,
    kind: GalleryKind,
    { before, limit, signal }: MediaQuery,
  ): Promise<Message[]> {
    if (signal?.aborted) return Promise.reject(new DOMException('Media aborted', 'AbortError'));
    return Promise.resolve(
      [...(this.timelines.get(conversationId) ?? [])]
        .filter((m) => (before === undefined || (m.seq ?? 0) < before) && hasGalleryItems(m, kind))
        .sort((a, b) => bySeq(b, a))
        .slice(0, Math.max(0, limit))
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

  pinned(conversationId: ConversationId, limit: number): Promise<Message[]> {
    return Promise.resolve(
      [...(this.timelines.get(conversationId) ?? [])]
        .filter((m) => m.pinned === true && !m.deleted)
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

  async stageOutgoing(pending: Message, entry: OutboxEntry): Promise<void> {
    this.store(clone(pending));
    await this.putOutbox(entry);
  }

  async commitOutgoing(
    nonce: string,
    final: Message,
    merge: MergeFn,
    media: readonly SentMedia[] = [],
  ): Promise<UpsertResult> {
    await this.discardOutgoing(nonce);
    const result = await this.upsert(final, merge);
    if (result.message.deleted === true) {
      // Deleted for everyone: no attachments, so no copy to keep.
      const stripped = {
        ...result.message,
        attachments: result.message.attachments.map(({ original: _o, ...rest }) => rest),
      };
      this.store(clone(stripped));
      return { ...result, message: stripped };
    }
    for (const item of media) {
      this.sentMedia.set(item.id, { conversationId: final.conversationId, data: item.data });
    }
    return result;
  }

  readSentMedia(id: string, type: string): Promise<Blob | undefined> {
    const media = this.sentMedia.get(id);
    return Promise.resolve(media ? new Blob([media.data], { type }) : undefined);
  }

  sentOriginalsUsage(scope?: SentOriginalsScope): Promise<SentOriginalsUsage> {
    const stopped = abortion(scope?.signal);
    if (stopped) return stopped;
    const ids =
      scope === undefined
        ? [...this.sentMedia.keys()]
        : this.originalMessages(scope.olderThan).flatMap(originalIds);
    let photos = 0;
    let bytes = 0;
    for (const id of ids) {
      const media = this.sentMedia.get(id);
      if (!media) continue;
      photos++;
      bytes += media.data.size;
    }
    return Promise.resolve({ photos, bytes });
  }

  dropSentOriginals(scope: SentOriginalsScope): Promise<SentOriginalsDropped> {
    const stopped = abortion(scope.signal);
    if (stopped) return stopped;
    const dropped: SentOriginalsDropped = { photos: 0, bytes: 0, attachmentIds: [] };
    for (const message of this.originalMessages(scope.olderThan)) {
      const ids = originalIds(message);
      for (const id of ids) {
        const media = this.sentMedia.get(id);
        if (!media) continue;
        dropped.photos++;
        dropped.bytes += media.data.size;
      }
      dropped.attachmentIds.push(...ids);
      // `store` removes the copies the new version no longer flags.
      this.store(
        clone({
          ...message,
          attachments: message.attachments.map(({ original: _o, ...rest }) => rest),
        }),
      );
    }
    return Promise.resolve(dropped);
  }

  private originalMessages(olderThan: number): Message[] {
    return [...this.messages.values()].filter(
      (m) => m.sentAt < olderThan && originalIds(m).length > 0,
    );
  }

  async discardOutgoing(nonce: string): Promise<void> {
    await this.delete(pendingMessageId(nonce));
    this.outbox.delete(nonce);
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
    this.sentMedia.clear();
    this.maxSeq = 0;
    this.minSeq = 1;
    return Promise.resolve();
  }
}
