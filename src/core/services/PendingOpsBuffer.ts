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
 * drain. Bounded by count and age so a target that never appears (the
 * message was dropped, or the op was for a conversation we'll never sync)
 * can't grow this forever.
 */
import type { Message, MessageId } from '@/core/domain';

/** Entries beyond this many are evicted oldest-first. */
export const PENDING_OPS_MAX = 500;
/** Entries older than this are dropped on the next hold/take. */
export const PENDING_OPS_TTL_MS = 5 * 60_000;

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
  ) {}

  /** Parks an operation for a target message we don't have yet. */
  hold(id: MessageId, apply: PendingOp, now: number): void {
    this.prune(now);
    this.entries.push({ id, apply, at: now });
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

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at <= this.ttlMs);
  }
}
