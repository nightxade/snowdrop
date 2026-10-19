/**
 * Holds delivery/read receipts for our own messages that we can't place yet.
 *
 * A recipient's receipt can overtake the backend's reply to our send (the
 * receipt names the server timestamp, which we only learn when `send()`
 * resolves). Rather than drop it, we park it briefly and apply it when the
 * send is reconciled. Entries expire so the buffer can't grow unbounded.
 */
import {
  advanceStatus,
  applyRecipientReceipt,
  type Message,
  type MessageStatus,
} from '@/core/domain';

export const RECEIPT_HOLD_MS = 60_000;

export interface HeldReceipt {
  /** The row-level status to apply (advances `Message.status`). */
  status: MessageStatus;
  at: number;
  /** Per-recipient detail of every held receipt so far, merged into `Message.receipts`. */
  recipients: Message['receipts'];
}

export class ReceiptBuffer {
  private readonly held = new Map<number, HeldReceipt>();

  constructor(private readonly ttlMs = RECEIPT_HOLD_MS) {}

  hold(sentAt: number, authorId: string, status: MessageStatus, now: number): void {
    this.prune(now);
    const existing = this.held.get(sentAt);
    const recipients =
      status === 'delivered' || status === 'read'
        ? applyRecipientReceipt(existing?.recipients, authorId, status, now)
        : existing?.recipients;
    this.held.set(sentAt, {
      status: existing ? advanceStatus(existing.status, status) : status,
      at: now,
      recipients,
    });
  }

  /** Removes and returns everything held for our message sent at `sentAt`. */
  take(sentAt: number, now: number): HeldReceipt | undefined {
    this.prune(now);
    const entry = this.held.get(sentAt);
    this.held.delete(sentAt);
    return entry;
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
