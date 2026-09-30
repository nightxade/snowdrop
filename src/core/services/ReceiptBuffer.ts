/**
 * Holds delivery/read receipts for our own messages that we can't place yet.
 *
 * A recipient's receipt can overtake the backend's reply to our send (the
 * receipt names the server timestamp, which we only learn when `send()`
 * resolves). Rather than drop it, we park it briefly and apply it when the
 * send is reconciled. Entries expire so the buffer can't grow unbounded.
 */
import { advanceStatus, type MessageStatus } from '@/core/domain';

export const RECEIPT_HOLD_MS = 60_000;

export class ReceiptBuffer {
  private readonly held = new Map<number, { status: MessageStatus; at: number }>();

  constructor(private readonly ttlMs = RECEIPT_HOLD_MS) {}

  hold(sentAt: number, status: MessageStatus, now: number): void {
    this.prune(now);
    const existing = this.held.get(sentAt);
    this.held.set(sentAt, {
      status: existing ? advanceStatus(existing.status, status) : status,
      at: now,
    });
  }

  /** Removes and returns the best status held for our message sent at `sentAt`. */
  take(sentAt: number, now: number): MessageStatus | undefined {
    this.prune(now);
    const entry = this.held.get(sentAt);
    this.held.delete(sentAt);
    return entry?.status;
  }

  get size(): number {
    return this.held.size;
  }

  private prune(now: number): void {
    for (const [sentAt, entry] of this.held) {
      if (now - entry.at > this.ttlMs) this.held.delete(sentAt);
    }
  }
}
