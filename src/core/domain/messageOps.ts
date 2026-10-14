/**
 * Pure, immutable message transitions shared by the sync engine, the send
 * pipeline and the mock backend, so every layer applies protocol semantics
 * identically.
 */
import type { BodyRange, LinkPreview, Message, MessageStatus, Reaction } from './types';

/** Signal allows one reaction per author per message; a new one replaces the old. */
export function applyReaction(
  reactions: readonly Reaction[],
  reaction: Reaction,
  remove: boolean,
): Reaction[] {
  const others = reactions.filter((r) => r.authorId !== reaction.authorId);
  if (remove) {
    const existing = reactions.find((r) => r.authorId === reaction.authorId);
    // Only remove if the emoji matches, otherwise a late "remove" could wipe a newer reaction.
    return existing && existing.emoji !== reaction.emoji ? [...reactions] : others;
  }
  return [...others, reaction];
}

const STATUS_RANK: Record<MessageStatus, number> = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** Receipts may arrive out of order; status only ever moves forward. */
export function advanceStatus(current: MessageStatus, next: MessageStatus): MessageStatus {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

/**
 * Applies an edit. Edits can arrive out of order (retries, multiple devices),
 * so one that isn't newer than what we already show is ignored — otherwise
 * the message could end on stale text.
 */
export function applyEdit(
  message: Message,
  edit: { body: string; ranges: BodyRange[]; editedAt: number; previews?: LinkPreview[] },
): Message {
  if (message.deleted) return message;
  if (message.editedAt !== undefined && edit.editedAt <= message.editedAt) return message;
  // signal-cli rebuilds the whole data message for an edit, so the preview
  // is replaced wholesale too (absent on the edit ⇒ no preview any more).
  const { previews: _previews, ...rest } = message;
  return {
    ...rest,
    body: edit.body,
    ranges: edit.ranges,
    edits: (message.edits ?? 0) + 1,
    editedAt: edit.editedAt,
    ...(edit.previews && edit.previews.length > 0 ? { previews: edit.previews } : {}),
  };
}

/**
 * Remote delete: keep the row (so the timeline doesn't shift) but drop
 * content. `deletedBy` is set for admin deletes (someone other than the author).
 */
export function applyDelete(message: Message, deletedBy?: string): Message {
  const { quote: _quote, pinned: _pinned, ...rest } = message;
  const out: Message = {
    ...rest,
    deleted: true,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
  };
  if (deletedBy !== undefined && deletedBy !== message.authorId) out.deletedBy = deletedBy;
  return out;
}

/**
 * Merges a message we already have with a re-delivery of it (duplicate
 * envelope, sync echo of our own send, backfilled history). The stored copy
 * wins for everything later events mutate — edits, reactions, deletion,
 * pinning, local seq — and delivery status only ever advances.
 */
export function mergeDuplicate(existing: Message, incoming: Message): Message {
  const merged: Message = {
    ...incoming,
    ...existing,
    status: advanceStatus(existing.status, incoming.status),
  };
  // A newer edit carried by the incoming copy still applies.
  if (
    incoming.editedAt !== undefined &&
    (existing.editedAt === undefined || incoming.editedAt > existing.editedAt) &&
    !existing.deleted
  ) {
    merged.body = incoming.body;
    merged.ranges = incoming.ranges;
    merged.editedAt = incoming.editedAt;
    merged.edits = Math.max(existing.edits ?? 0, incoming.edits ?? 0);
  }
  return merged;
}

/**
 * Merge for `MessageRepository.commitOutgoing`: `final` is our own send's
 * authoritative result — its reserved seq (so the message keeps the spot the
 * optimistic row held, however long the round trip took), its nonce, and
 * attachment/preview fields already reconciled by `withLocalUrls`/
 * `finalPreview`. If a sync-transcript echo of our own send created the row
 * first, plain `mergeDuplicate` would let *that* row's independently-
 * allocated seq, attachments and preview win instead, moving the message in
 * the timeline and dropping the local preview. Everything else a duplicate
 * delivery should still keep — edits, reactions, deletion, pinning, and the
 * max of both statuses — still comes from `mergeDuplicate`, unchanged for
 * every other caller.
 */
export function mergeOutgoingCommit(existing: Message, final: Message): Message {
  const merged = mergeDuplicate(existing, final);
  const { nonce: _nonce, previews: _previews, ...rest } = merged;
  return {
    ...rest,
    attachments: final.attachments,
    ...(final.previews ? { previews: final.previews } : {}),
    ...(final.nonce === undefined ? {} : { nonce: final.nonce }),
    ...(final.seq === undefined ? {} : { seq: final.seq }),
  };
}

/** Summarises reactions into pills: emoji → authors, in first-seen order. */
export function summarizeReactions(
  reactions: readonly Reaction[],
): { emoji: string; authorIds: string[]; firstAt: number }[] {
  const byEmoji = new Map<string, { emoji: string; authorIds: string[]; firstAt: number }>();
  for (const r of [...reactions].sort((a, b) => a.at - b.at)) {
    const entry = byEmoji.get(r.emoji);
    if (entry) entry.authorIds.push(r.authorId);
    else byEmoji.set(r.emoji, { emoji: r.emoji, authorIds: [r.authorId], firstAt: r.at });
  }
  return [...byEmoji.values()];
}
