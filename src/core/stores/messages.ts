import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationId, Message, MessageId } from '@/core/domain';

/**
 * The slice of a conversation's history currently held in memory. The full
 * history lives in the repository; windows grow as the user scrolls back.
 */
export interface ConversationWindow {
  /** Ascending by (sentAt, id). */
  ids: MessageId[];
  byId: Record<MessageId, Message>;
  hasMoreBefore: boolean;
  loading: boolean;
  /** False until the initial page has been loaded (live messages may arrive before that). */
  loaded: boolean;
}

export interface MessagesState {
  windows: Record<ConversationId, ConversationWindow>;

  /** Replaces a window's content with an initial page, merging any live arrivals. */
  setInitialPage(
    conversationId: ConversationId,
    messages: readonly Message[],
    hasMoreBefore: boolean,
  ): void;
  /** Adds an older page. */
  prependPage(
    conversationId: ConversationId,
    messages: readonly Message[],
    hasMoreBefore: boolean,
  ): void;
  setLoading(conversationId: ConversationId, loading: boolean): void;
  /** Inserts or replaces a message, keeping order. */
  upsert(message: Message): void;
  update(conversationId: ConversationId, id: MessageId, fn: (m: Message) => Message): void;
  remove(conversationId: ConversationId, id: MessageId): void;
  /**
   * Swaps an optimistic message (found by nonce) for the acknowledged one.
   * Keeps the nonce on the result so render keys stay stable. If the final
   * message already arrived (e.g. a sync echo), the two are merged.
   */
  reconcile(conversationId: ConversationId, nonce: string, final: Message): void;
  findByNonce(conversationId: ConversationId, nonce: string): Message | undefined;
}

export type MessagesStore = StoreApi<MessagesState>;

const EMPTY_WINDOW: ConversationWindow = Object.freeze({
  ids: [],
  byId: {},
  hasMoreBefore: true,
  loading: false,
  loaded: false,
});

function compare(a: Message, b: Message): number {
  return a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Merges messages into a window, returning a new window (inputs untouched). */
function mergeInto(window: ConversationWindow, messages: readonly Message[]): ConversationWindow {
  if (messages.length === 0) return window;
  const byId = { ...window.byId };
  let needsSort = false;
  const ids = [...window.ids];
  for (const m of messages) {
    if (!(m.id in byId)) {
      const last = ids.at(-1);
      if (last !== undefined && compare(byId[last] as Message, m) > 0) needsSort = true;
      ids.push(m.id);
    }
    byId[m.id] = m;
  }
  if (needsSort) ids.sort((a, b) => compare(byId[a] as Message, byId[b] as Message));
  return { ...window, ids, byId };
}

function removeFrom(window: ConversationWindow, id: MessageId): ConversationWindow {
  if (!(id in window.byId)) return window;
  const { [id]: _removed, ...byId } = window.byId;
  return { ...window, ids: window.ids.filter((x) => x !== id), byId };
}

export function createMessagesStore(): MessagesStore {
  return createStore<MessagesState>()((set, get) => {
    const windowOf = (id: ConversationId): ConversationWindow => get().windows[id] ?? EMPTY_WINDOW;
    const put = (id: ConversationId, window: ConversationWindow): void => {
      if (get().windows[id] === window) return;
      set((s) => ({ windows: { ...s.windows, [id]: window } }));
    };

    return {
      windows: {},

      setInitialPage: (conversationId, messages, hasMoreBefore) => {
        const merged = mergeInto(windowOf(conversationId), messages);
        put(conversationId, { ...merged, hasMoreBefore, loaded: true, loading: false });
      },
      prependPage: (conversationId, messages, hasMoreBefore) => {
        const merged = mergeInto(windowOf(conversationId), messages);
        put(conversationId, { ...merged, hasMoreBefore, loading: false });
      },
      setLoading: (conversationId, loading) => {
        const w = windowOf(conversationId);
        if (w.loading !== loading) put(conversationId, { ...w, loading });
      },
      upsert: (message) => {
        put(message.conversationId, mergeInto(windowOf(message.conversationId), [message]));
      },
      update: (conversationId, id, fn) => {
        const w = windowOf(conversationId);
        const current = w.byId[id];
        if (!current) return;
        const next = fn(current);
        if (next === current) return;
        put(conversationId, mergeInto(w, [next]));
      },
      remove: (conversationId, id) => {
        put(conversationId, removeFrom(windowOf(conversationId), id));
      },
      reconcile: (conversationId, nonce, final) => {
        const w = windowOf(conversationId);
        const pending = get().findByNonce(conversationId, nonce);
        let next = pending && pending.id !== final.id ? removeFrom(w, pending.id) : w;
        const existing = next.byId[final.id];
        next = mergeInto(next, [{ ...(existing ?? {}), ...final, nonce }]);
        put(conversationId, next);
      },
      findByNonce: (conversationId, nonce) => {
        const w = windowOf(conversationId);
        // Optimistic messages sit at the end; search backwards.
        for (let i = w.ids.length - 1; i >= 0; i--) {
          const m = w.byId[w.ids[i] as MessageId];
          if (m?.nonce === nonce) return m;
        }
        return undefined;
      },
    };
  });
}

const listCache = new WeakMap<ConversationWindow, Message[]>();

export const messagesSelectors = {
  window: (id: ConversationId) => (s: MessagesState) => s.windows[id] ?? EMPTY_WINDOW,
  /** Ordered messages; memoised on window identity so it's safe for React selectors. */
  list:
    (id: ConversationId) =>
    (s: MessagesState): Message[] => {
      const w = s.windows[id] ?? EMPTY_WINDOW;
      let list = listCache.get(w);
      if (!list) {
        list = w.ids.map((mid) => w.byId[mid] as Message);
        listCache.set(w, list);
      }
      return list;
    },
  message: (conversationId: ConversationId, id: MessageId) => (s: MessagesState) =>
    s.windows[conversationId]?.byId[id],
  /** Newest own, non-deleted, normal message — the target of "↑ to edit". */
  lastOwn: (conversationId: ConversationId, selfId: string) => (s: MessagesState) => {
    const w = s.windows[conversationId];
    if (!w) return undefined;
    for (let i = w.ids.length - 1; i >= 0; i--) {
      const m = w.byId[w.ids[i] as MessageId];
      if (m && m.authorId === selfId && m.kind === 'normal' && !m.deleted && m.status !== 'failed')
        return m;
    }
    return undefined;
  },
};
