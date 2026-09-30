/**
 * Turns group-update envelopes into correct "what changed" lines.
 *
 * signal-cli only says *that* a group changed; we learn *what* by re-listing
 * it, which always returns the latest state. Two consequences handled here:
 * - The "before" snapshot must be taken when the update *arrives*, not when
 *   it is processed: a directory reload in between would otherwise already
 *   contain the new state and the diff would be empty.
 * - Several updates to one group queued back to back all see the same latest
 *   state. Only the last one of such a run re-lists and diffs (against the
 *   snapshot from before the first); with more than one author involved, the
 *   line is phrased without an actor rather than misattributing changes.
 */
import type { Conversation, ConversationId } from '@/core/domain';

interface Run {
  before: Conversation | undefined;
  pending: number;
  actors: Set<string>;
}

export interface GroupChangeTurn {
  /** False while more updates to the same group are queued behind this one. */
  last: boolean;
  before: Conversation | undefined;
  /** The single actor of the run, or null when several people changed things. */
  actorId: string | null;
}

export class GroupChangeTracker {
  private readonly runs = new Map<ConversationId, Run>();

  /** Call when an update is queued, with the group as currently known. */
  arrived(id: ConversationId, current: Conversation | undefined, actorId: string): void {
    const run = this.runs.get(id);
    if (run) {
      run.pending++;
      run.actors.add(actorId);
      return;
    }
    this.runs.set(id, {
      before: current ? structuredClone(current) : undefined,
      pending: 1,
      actors: new Set([actorId]),
    });
  }

  /** Call when a queued update is processed. */
  take(id: ConversationId): GroupChangeTurn {
    const run = this.runs.get(id);
    if (!run) return { last: true, before: undefined, actorId: null };
    run.pending--;
    const last = run.pending <= 0;
    if (last) this.runs.delete(id);
    const [only] = run.actors;
    return { last, before: run.before, actorId: run.actors.size === 1 ? (only ?? null) : null };
  }

  clear(): void {
    this.runs.clear();
  }
}
