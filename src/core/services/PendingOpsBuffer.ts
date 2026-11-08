/**
 * Holds message-targeting operations (delete, reaction, edit, pin) whose
 * target we don't have yet: an envelope out of order, or a race with our own
 * send landing before `commitOutgoing` reconciles it. Generalises
 * ReceiptBuffer's idea — a receipt names a sender timestamp we might not
 * have reconciled yet — to every operation that targets a message id.
 *
 * Entries are applied once, in arrival order, when the target shows up:
 * SyncService.onMessage (before the message is stored or emitted) and
 * SendService.attempt (right after commitOutgoing), alongside the receipt
 * drain, and when history is backfilled (an old message the local store
 * doesn't hold yet can be paged in hours later). Signal Desktop keeps such
 * early arrivals until their target shows up; we hold them for a day, bounded
 * by count as well, so a target that never appears (the message was dropped,
 * or the op was for a conversation we'll never sync) can't grow this forever.
 */
import type { Message, MessageId } from '@/core/domain';

/** Entries beyond this many are evicted oldest-first. */
export const PENDING_OPS_MAX = 2000;
/**
 * No one author's messages may hold more than this many entries: a burst of
 * operations on one author's old messages (common right after linking) evicts
 * that author's own oldest entries, not other people's early arrivals.
 */
export const PENDING_OPS_PER_AUTHOR_MAX = 500;
/** Entries older than this are dropped on the next hold/take. */
export const PENDING_OPS_TTL_MS = 24 * 60 * 60_000;

export type PendingOp = (message: Message) => Message;

interface Entry {
  id: MessageId;
  apply: PendingOp;
  at: number;
}

export class PendingOpsBuffer {
  private entries: Entry[] = [];

  constructor(
    private readonly maxEntries = PENDING_OPS_MAX,
    private readonly ttlMs = PENDING_OPS_TTL_MS,
    private readonly maxPerAuthor = PENDING_OPS_PER_AUTHOR_MAX,
  ) {}

  /** Parks an operation for a target message we don't have yet. */
  hold(id: MessageId, apply: PendingOp, now: number): void {
    this.prune(now);
    this.entries.push({ id, apply, at: now });
    const author = authorOf(id);
    let mine = 0;
    for (const e of this.entries) if (authorOf(e.id) === author) mine += 1;
    if (mine > this.maxPerAuthor) {
      const oldest = this.entries.findIndex((e) => authorOf(e.id) === author);
      this.entries.splice(oldest, 1);
    }
    // Oldest first: the buffer is in arrival order.
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  /** Removes and returns every held operation for `id`, oldest first. */
  take(id: MessageId, now: number): PendingOp[] {
    this.prune(now);
    const mine: PendingOp[] = [];
    this.entries = this.entries.filter((e) => {
      if (e.id !== id) return true;
      mine.push(e.apply);
      return false;
    });
    return mine;
  }

  /**
   * `messages` with each one's held operations applied. The operations leave
   * the buffer; if the write that follows fails, `restore()` puts them back
   * (with their original ages) so they aren't lost with the failed page.
   */
  applyTo(messages: readonly Message[], now: number): { messages: Message[]; restore: () => void } {
    if (this.entries.length === 0) return { messages: [...messages], restore: () => undefined };
    this.prune(now);
    const ids = new Set(messages.map((m) => m.id));
    const taken = this.entries.filter((e) => ids.has(e.id));
    this.entries = this.entries.filter((e) => !ids.has(e.id));
    const applied = messages.map((m) =>
      taken.reduce((acc, e) => (e.id === m.id ? e.apply(acc) : acc), m),
    );
    return {
      messages: applied,
      restore: () => {
        this.entries = [...taken, ...this.entries].sort((a, b) => a.at - b.at);
        while (this.entries.length > this.maxEntries) this.entries.shift();
      },
    };
  }

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at <= this.ttlMs);
  }
}

/** Whose message an id names (`<author>:<sentAt>`). */
function authorOf(id: MessageId): string {
  return id.slice(0, id.lastIndexOf(':'));
}
