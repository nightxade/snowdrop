/**
 * Protocol-level conversation state plus read state.
 *
 * Read cursors and unread counts are keyed on `seq` (local arrival order),
 * never on sender timestamps: a sender with a skewed clock must still
 * produce an unread badge. Local organisation (pin/mute/archive/draft) is in
 * `localStore`; `views.ts` combines the two for rendering.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  mentionsContact,
  type Conversation,
  type ConversationId,
  type Message,
  type MuteState,
} from '@/core/domain';

export interface UnreadState {
  count: number;
  mentions: number;
}

export const NO_UNREAD: UnreadState = Object.freeze({ count: 0, mentions: 0 });

export interface ConversationsState {
  byId: Record<ConversationId, Conversation>;
  /** seq of the last message the user has read, per conversation. */
  readCursors: Record<ConversationId, number>;
  unread: Record<ConversationId, UnreadState>;
  /** Newest known message per conversation (sidebar previews). */
  lastMessage: Record<ConversationId, Message>;

  upsertMany(conversations: readonly Conversation[]): void;
  /** Replaces protocol fields, keeping the newest local activity time. */
  upsert(conversation: Conversation): void;
  /** Drops conversations that turned out not to belong (see SyncService's stale-peer filter). */
  removeMany(ids: readonly ConversationId[]): void;
  /** Moves lastActivityAt forward (never backward: late events must not reorder the list). */
  bumpActivity(id: ConversationId, at: number): void;
  setReadCursors(cursors: Record<ConversationId, number>): void;
  setUnread(id: ConversationId, unread: UnreadState): void;
  /** Counts a newly stored message if it's unread; see countsAsUnread. */
  applyIncoming(message: Message, selfId: string): void;
  /** Un-counts a message that stopped counting (deleted) if it was unread. */
  applyRemoval(message: Message, selfId: string): void;
  /**
   * Advances the read cursor to `upToSeq` and clears unread. Returns true if anything changed.
   * With `read` (what the caller actually read, counted from the messages up
   * to `upToSeq`), only that much is taken off the badge: a message counted
   * since, beyond `upToSeq`, stays unread. Without it the badge is cleared.
   */
  markRead(id: ConversationId, upToSeq: number, read?: UnreadState): boolean;
  /**
   * Records `message` as the preview if it is newer (by seq) than the current
   * one, or is the same message (same id or nonce) in a newer state.
   */
  noteLatest(message: Message): void;
  /**
   * The message `removedId` left the conversation (deleted here, expired,
   * purged): if it is still the preview, `next` (the newest message that
   * remains, if any) takes its place. A preview that has since moved on to
   * another message is left alone. Unlike `noteLatest` this can go backwards.
   */
  replaceLatest(id: ConversationId, removedId: Message['id'], next: Message | undefined): void;
}

export type ConversationsStore = StoreApi<ConversationsState>;

/**
 * Whether a message contributes to the unread badge: it's from someone else,
 * it's a real (non-system, non-deleted) message and it arrived after the cursor.
 */
export function countsAsUnread(
  message: Message,
  selfId: string,
  cursor: number | undefined,
): boolean {
  return (
    message.authorId !== selfId &&
    message.kind === 'normal' &&
    !message.deleted &&
    message.seq !== undefined &&
    (cursor === undefined || message.seq > cursor)
  );
}

/** Unread & mention counts for a set of messages given a read cursor. */
export function computeUnread(
  messages: readonly Message[],
  selfId: string,
  cursor: number | undefined,
): UnreadState {
  let count = 0;
  let mentions = 0;
  for (const m of messages) {
    if (!countsAsUnread(m, selfId, cursor)) continue;
    count++;
    if (mentionsContact(m, selfId)) mentions++;
  }
  return count === 0 ? NO_UNREAD : { count, mentions };
}

export function isMuted(muted: MuteState, now: number): boolean {
  return typeof muted === 'boolean' ? muted : muted.until > now;
}

export function createConversationsStore(): ConversationsStore {
  return createStore<ConversationsState>()((set, get) => {
    const adjustUnread = (message: Message, selfId: string, delta: 1 | -1): void => {
      const id = message.conversationId;
      if (!countsAsUnread(message, selfId, get().readCursors[id])) return;
      const current = get().unread[id] ?? NO_UNREAD;
      get().setUnread(id, {
        count: Math.max(0, current.count + delta),
        mentions: Math.max(0, current.mentions + (mentionsContact(message, selfId) ? delta : 0)),
      });
    };

    return {
      byId: {},
      readCursors: {},
      unread: {},
      lastMessage: {},

      upsertMany: (conversations) => {
        if (conversations.length === 0) return;
        set((s) => {
          const byId = { ...s.byId };
          for (const c of conversations) {
            const existing = byId[c.id];
            byId[c.id] = existing
              ? { ...c, lastActivityAt: Math.max(c.lastActivityAt, existing.lastActivityAt) }
              : c;
          }
          return { byId };
        });
      },
      upsert: (conversation) => {
        get().upsertMany([conversation]);
      },
      removeMany: (ids) => {
        if (ids.length === 0) return;
        const drop = new Set<ConversationId>(ids);
        set((s) => ({
          byId: Object.fromEntries(
            Object.entries(s.byId).filter(([id]) => !drop.has(id as ConversationId)),
          ),
          lastMessage: Object.fromEntries(
            Object.entries(s.lastMessage).filter(([id]) => !drop.has(id as ConversationId)),
          ),
        }));
      },
      bumpActivity: (id, at) => {
        const current = get().byId[id];
        if (!current || current.lastActivityAt >= at) return;
        set((s) => ({ byId: { ...s.byId, [id]: { ...current, lastActivityAt: at } } }));
      },
      setReadCursors: (cursors) => {
        set((s) => ({ readCursors: { ...s.readCursors, ...cursors } }));
      },
      setUnread: (id, unread) => {
        const current = get().unread[id] ?? NO_UNREAD;
        if (current.count === unread.count && current.mentions === unread.mentions) return;
        set((s) => ({ unread: { ...s.unread, [id]: unread.count === 0 ? NO_UNREAD : unread } }));
      },
      applyIncoming: (message, selfId) => {
        adjustUnread(message, selfId, 1);
      },
      applyRemoval: (message, selfId) => {
        adjustUnread(message, selfId, -1);
      },
      markRead: (id, upToSeq, read) => {
        const s = get();
        const cursor = s.readCursors[id];
        const current = s.unread[id] ?? NO_UNREAD;
        const hadUnread = current.count > 0;
        if (cursor !== undefined && cursor >= upToSeq && !hadUnread) return false;
        const remaining: UnreadState = read
          ? {
              count: Math.max(0, current.count - read.count),
              mentions: Math.max(0, current.mentions - read.mentions),
            }
          : NO_UNREAD;
        set((state) => ({
          readCursors: { ...state.readCursors, [id]: Math.max(cursor ?? upToSeq, upToSeq) },
          unread: { ...state.unread, [id]: remaining.count === 0 ? NO_UNREAD : remaining },
        }));
        return true;
      },
      replaceLatest: (id, removedId, next) => {
        const current = get().lastMessage[id];
        if (current?.id !== removedId) return;
        set((s) => {
          if (next) return { lastMessage: { ...s.lastMessage, [id]: next } };
          return {
            lastMessage: Object.fromEntries(
              Object.entries(s.lastMessage).filter(([key]) => key !== id),
            ),
          };
        });
      },
      noteLatest: (message) => {
        if (message.previewless === true) return;
        const id = message.conversationId;
        const current = get().lastMessage[id];
        if (current === message) return;
        const same =
          current !== undefined &&
          (current.id === message.id ||
            (current.nonce !== undefined && current.nonce === message.nonce));
        const newer =
          current === undefined ||
          (message.seq ?? Number.MAX_SAFE_INTEGER) > (current.seq ?? Number.MAX_SAFE_INTEGER);
        if (!same && !newer) return;
        set((s) => ({ lastMessage: { ...s.lastMessage, [id]: message } }));
      },
    };
  });
}

export const conversationsSelectors = {
  byId: (s: ConversationsState) => s.byId,
  conversation: (id: ConversationId) => (s: ConversationsState) => s.byId[id],
  unread: (id: ConversationId) => (s: ConversationsState) => s.unread[id] ?? NO_UNREAD,
  readCursor: (id: ConversationId) => (s: ConversationsState) => s.readCursors[id],
  lastMessage: (id: ConversationId) => (s: ConversationsState) => s.lastMessage[id],
};
