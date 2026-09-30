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
  /** sentAt of the last message the user has read, per conversation. */
  readCursors: Record<ConversationId, number>;
  unread: Record<ConversationId, UnreadState>;

  upsertMany(conversations: readonly Conversation[]): void;
  upsert(conversation: Conversation): void;
  patch(id: ConversationId, patch: Partial<Omit<Conversation, 'id'>>): void;
  /** Moves lastActivityAt forward (never backward: late events must not reorder the list). */
  bumpActivity(id: ConversationId, at: number): void;
  setReadCursors(cursors: Record<ConversationId, number>): void;
  setUnread(id: ConversationId, unread: UnreadState): void;
  /** Counts an incoming message if it's unread; see countsAsUnread. */
  applyIncoming(message: Message, selfId: string): void;
  /** Advances the read cursor to `upTo` and clears unread. Returns true if anything changed. */
  markRead(id: ConversationId, upTo: number): boolean;
}

export type ConversationsStore = StoreApi<ConversationsState>;

/**
 * Whether a message contributes to the unread badge: it's from someone else,
 * it's a real (non-system, non-deleted) message and it's after the cursor.
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
    (cursor === undefined || message.sentAt > cursor)
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
  return createStore<ConversationsState>()((set, get) => ({
    byId: {},
    readCursors: {},
    unread: {},

    upsertMany: (conversations) => {
      if (conversations.length === 0) return;
      set((s) => {
        const byId = { ...s.byId };
        for (const c of conversations) byId[c.id] = c;
        return { byId };
      });
    },
    upsert: (conversation) => {
      set((s) => ({ byId: { ...s.byId, [conversation.id]: conversation } }));
    },
    patch: (id, patch) => {
      const current = get().byId[id];
      if (!current) return;
      set((s) => ({ byId: { ...s.byId, [id]: { ...current, ...patch } } }));
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
      set((s) => ({ unread: { ...s.unread, [id]: unread } }));
    },
    applyIncoming: (message, selfId) => {
      const id = message.conversationId;
      if (!countsAsUnread(message, selfId, get().readCursors[id])) return;
      const current = get().unread[id] ?? NO_UNREAD;
      get().setUnread(id, {
        count: current.count + 1,
        mentions: current.mentions + (mentionsContact(message, selfId) ? 1 : 0),
      });
    },
    markRead: (id, upTo) => {
      const s = get();
      const cursor = s.readCursors[id];
      const hadUnread = (s.unread[id]?.count ?? 0) > 0;
      if (cursor !== undefined && cursor >= upTo && !hadUnread) return false;
      set((state) => ({
        readCursors: { ...state.readCursors, [id]: Math.max(cursor ?? 0, upTo) },
        unread: { ...state.unread, [id]: NO_UNREAD },
      }));
      return true;
    },
  }));
}

/** Pinned first is a sidebar concern; this is the canonical recency order. */
function compareByActivity(a: Conversation, b: Conversation): number {
  return b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title);
}

const orderedCache = new WeakMap<Record<ConversationId, Conversation>, Conversation[]>();

export const conversationsSelectors = {
  byId: (s: ConversationsState) => s.byId,
  conversation: (id: ConversationId) => (s: ConversationsState) => s.byId[id],
  /** Stable (memoised on byId identity) list, most recent activity first; archived excluded. */
  ordered: (s: ConversationsState): Conversation[] => {
    let cached = orderedCache.get(s.byId);
    if (!cached) {
      cached = Object.values(s.byId)
        .filter((c) => !c.archived)
        .sort(compareByActivity);
      orderedCache.set(s.byId, cached);
    }
    return cached;
  },
  unread: (id: ConversationId) => (s: ConversationsState) => s.unread[id] ?? NO_UNREAD,
  readCursor: (id: ConversationId) => (s: ConversationsState) => s.readCursors[id],
};

/** Sum of unread across conversations, skipping muted ones for the count (mentions always count). */
export function totalUnread(
  s: Pick<ConversationsState, 'byId' | 'unread'>,
  ids: readonly ConversationId[],
  now: number,
): UnreadState & { hasUnread: boolean } {
  let count = 0;
  let mentions = 0;
  let hasUnread = false;
  for (const id of ids) {
    const u = s.unread[id];
    const conv = s.byId[id];
    if (!u || !conv) continue;
    mentions += u.mentions;
    if (!isMuted(conv.muted, now)) {
      count += u.count;
      if (u.count > 0) hasUnread = true;
    }
  }
  return { count, mentions, hasUnread };
}
