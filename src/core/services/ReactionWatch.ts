/**
 * Notes reactions taken back from a message while one of our operations on it
 * is in flight. A delete that fails is undone by restoring the reactions it
 * cleared, and one that someone took back meanwhile must not come back with
 * them. Shared by SendService (which watches) and SyncService (which reports).
 */
import type { MessageId } from '@/core/domain';

export class ReactionWatch {
  private readonly watched = new Map<MessageId, Set<string>>();

  /** Starts noting removals on `id`. */
  begin(id: MessageId): void {
    this.watched.set(id, new Set());
  }

  /** A reaction by `authorId` on `id` was taken back (ignored unless watched). */
  noteRemoved(id: MessageId, authorId: string): void {
    this.watched.get(id)?.add(authorId);
  }

  /** Who took their reaction back since `begin`. */
  removed(id: MessageId): ReadonlySet<string> {
    return this.watched.get(id) ?? new Set();
  }

  end(id: MessageId): void {
    this.watched.delete(id);
  }
}
