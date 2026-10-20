/**
 * In-memory windows onto conversation history.
 *
 * A window is a contiguous slice of a conversation's timeline (ordered by
 * `seq`). It can be anchored to the present (live messages append to it) or
 * detached (the user jumped back to an old message; live messages don't
 * belong in it). Windows are capped and evict from the side far from where
 * the user is heading, so long scrolling sessions don't grow memory unbounded.
 *
 * In-place updates (edits, reactions, receipts) keep the `ids` array
 * identity, so layout derived from it (grouping, virtualiser keys) is not
 * recomputed; only the affected row, subscribed by id, re-renders.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  groupMessages,
  isPendingMessageId,
  type ConversationId,
  type Message,
  type MessageId,
  type RenderItem,
} from '@/core/domain';

export interface ConversationWindow {
  /** Ascending by (seq, id). */
  ids: MessageId[];
  byId: Record<MessageId, Message>;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** True when the window ends at the newest message; live messages append only then. */
  anchoredToPresent: boolean;
  loading: boolean;
  /** False until a page has been loaded. */
  loaded: boolean;
}

export interface WindowFlags {
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** Default maximum messages held per conversation window. */
export const WINDOW_CAP = 400;

export interface MessagesState {
  windows: Record<ConversationId, ConversationWindow>;

  /** Replaces a window (initial load, jump to message, jump to present). */
  replaceWindow(
    conversationId: ConversationId,
    messages: readonly Message[],
    flags: WindowFlags,
  ): void;
  /** Adds an older page; evicts from the newest side beyond the cap. */
  prependPage(
    conversationId: ConversationId,
    messages: readonly Message[],
    hasMoreBefore: boolean,
  ): void;
  /** Adds a newer page (detached windows); evicts from the oldest side beyond the cap. */
  appendPage(
    conversationId: ConversationId,
    messages: readonly Message[],
    hasMoreAfter: boolean,
  ): void;
  setLoading(conversationId: ConversationId, loading: boolean): void;
  /**
   * A message that just arrived or was just sent. Appended only to a loaded
   * window anchored to the present; if the message is already in any window
   * it's replaced in place. Returns whether it's now in the store.
   */
  appendLive(message: Message): boolean;
  /** Replaces a message if it's loaded; no-op otherwise. */
  update(conversationId: ConversationId, id: MessageId, fn: (m: Message) => Message): void;
  remove(conversationId: ConversationId, id: MessageId): void;
  /**
   * Drops a conversation's window entirely (an
   * LRU over open conversations, owned by HistoryService, calls this on the
   * least-recently-opened one once too many are held). Safe at any time,
   * including mid-load: every read site already treats a missing window the
   * same as a never-opened one (`?? EMPTY_WINDOW`), and HistoryService's own
   * generation token means a load in flight for this conversation discards
   * its result instead of resurrecting the window.
   */
  closeWindow(conversationId: ConversationId): void;
  /**
   * Swaps an optimistic message (found by nonce) for the acknowledged one in
   * the same timeline position. If the acknowledged id is already present
   * (a sync echo won the race) the two rows are merged.
   */
  reconcile(conversationId: ConversationId, nonce: string, final: Message): void;
  findByNonce(conversationId: ConversationId, nonce: string): Message | undefined;
}

export type MessagesStore = StoreApi<MessagesState>;

const EMPTY_WINDOW: ConversationWindow = Object.freeze({
  ids: [],
  byId: {},
  hasMoreBefore: true,
  hasMoreAfter: false,
  anchoredToPresent: true,
  loading: false,
  loaded: false,
});

function compare(a: Message, b: Message): number {
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
  return sa - sb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Merges messages into a window, returning a new window (inputs untouched). */
function mergeInto(window: ConversationWindow, messages: readonly Message[]): ConversationWindow {
  if (messages.length === 0) return window;
  const byId = { ...window.byId };
  let ids = window.ids;
  let needsSort = false;
  for (const m of messages) {
    const existing = byId[m.id];
    if (!existing) {
      if (ids === window.ids) ids = [...ids];
      const lastId = ids.at(-1);
      const last = lastId === undefined ? undefined : byId[lastId];
      if (last && compare(last, m) > 0) needsSort = true;
      ids.push(m.id);
    } else if (existing.seq !== m.seq) {
      needsSort = true;
    }
    byId[m.id] = m;
  }
  if (needsSort) {
    if (ids === window.ids) ids = [...ids];
    ids.sort((a, b) => compare(byId[a] as Message, byId[b] as Message));
  }
  return { ...window, ids, byId };
}

function removeFrom(window: ConversationWindow, id: MessageId): ConversationWindow {
  if (!(id in window.byId)) return window;
  const { [id]: _removed, ...byId } = window.byId;
  return { ...window, ids: window.ids.filter((x) => x !== id), byId };
}

/** Drops ids beyond the cap from one side. */
function evict(
  window: ConversationWindow,
  cap: number,
  side: 'oldest' | 'newest',
): ConversationWindow {
  const excess = window.ids.length - cap;
  if (excess <= 0) return window;
  const ids = side === 'oldest' ? window.ids.slice(excess) : window.ids.slice(0, -excess);
  const byId: Record<MessageId, Message> = {};
  for (const id of ids) {
    const m = window.byId[id];
    if (m) byId[id] = m;
  }
  return side === 'oldest'
    ? { ...window, ids, byId, hasMoreBefore: true }
    : { ...window, ids, byId, hasMoreAfter: true, anchoredToPresent: false };
}

export function createMessagesStore(cap = WINDOW_CAP): MessagesStore {
  return createStore<MessagesState>()((set, get) => {
    const windowOf = (id: ConversationId): ConversationWindow => get().windows[id] ?? EMPTY_WINDOW;
    const put = (id: ConversationId, window: ConversationWindow): void => {
      if (get().windows[id] === window) return;
      set((s) => ({ windows: { ...s.windows, [id]: window } }));
    };

    return {
      windows: {},

      replaceWindow: (conversationId, messages, flags) => {
        const base: ConversationWindow = {
          ...EMPTY_WINDOW,
          ...flags,
          anchoredToPresent: !flags.hasMoreAfter,
          loaded: true,
        };
        put(conversationId, mergeInto(base, messages));
      },
      prependPage: (conversationId, messages, hasMoreBefore) => {
        const merged = mergeInto(windowOf(conversationId), messages);
        put(conversationId, evict({ ...merged, hasMoreBefore, loading: false }, cap, 'newest'));
      },
      appendPage: (conversationId, messages, hasMoreAfter) => {
        const merged = mergeInto(windowOf(conversationId), messages);
        put(
          conversationId,
          evict(
            { ...merged, hasMoreAfter, anchoredToPresent: !hasMoreAfter, loading: false },
            cap,
            'oldest',
          ),
        );
      },
      setLoading: (conversationId, loading) => {
        const w = windowOf(conversationId);
        if (w.loading !== loading) put(conversationId, { ...w, loading });
      },
      appendLive: (message) => {
        const w = get().windows[message.conversationId];
        if (!w) return false;
        if (message.id in w.byId) {
          put(message.conversationId, mergeInto(w, [message]));
          return true;
        }
        if (!w.loaded || !w.anchoredToPresent) return false;
        put(message.conversationId, evict(mergeInto(w, [message]), cap, 'oldest'));
        return true;
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
      closeWindow: (conversationId) => {
        if (!(conversationId in get().windows)) return;
        set((s) => {
          const { [conversationId]: _closed, ...windows } = s.windows;
          return { windows };
        });
      },
      reconcile: (conversationId, nonce, final) => {
        const w = windowOf(conversationId);
        const pending = get().findByNonce(conversationId, nonce);
        const without = pending && pending.id !== final.id ? removeFrom(w, pending.id) : w;
        const existing = without.byId[final.id];
        const merged: Message = existing ? { ...existing, ...final, nonce } : { ...final, nonce };
        // Only materialise it if the window shows that region of the timeline.
        if (pending || existing || (w.loaded && w.anchoredToPresent)) {
          put(conversationId, mergeInto(without, [merged]));
        }
      },
      findByNonce: (conversationId, nonce) => {
        const w = windowOf(conversationId);
        // Outgoing messages sit near the end; search backwards.
        for (let i = w.ids.length - 1; i >= 0; i--) {
          const id = w.ids[i];
          const m = id === undefined ? undefined : w.byId[id];
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
  /** Stable while only message contents change (use with per-row `message` selectors). */
  ids: (id: ConversationId) => (s: MessagesState) => (s.windows[id] ?? EMPTY_WINDOW).ids,
  /** Ordered messages; memoised on window identity. Prefer `ids` + `message` in lists. */
  list:
    (id: ConversationId) =>
    (s: MessagesState): Message[] => {
      const w = s.windows[id] ?? EMPTY_WINDOW;
      let list = listCache.get(w);
      if (!list) {
        list = w.ids.flatMap((mid) => {
          const m = w.byId[mid];
          return m ? [m] : [];
        });
        listCache.set(w, list);
      }
      return list;
    },
  message: (conversationId: ConversationId, id: MessageId) => (s: MessagesState) =>
    s.windows[conversationId]?.byId[id],
  /**
   * Newest own, acknowledged, non-deleted message — the target of "↑ to edit".
   * Pending/failed messages are excluded: they have no server identity yet.
   */
  lastOwn: (conversationId: ConversationId, selfId: string) => (s: MessagesState) => {
    const w = s.windows[conversationId];
    if (!w) return undefined;
    for (let i = w.ids.length - 1; i >= 0; i--) {
      const id = w.ids[i];
      const m = id === undefined ? undefined : w.byId[id];
      if (
        m &&
        m.authorId === selfId &&
        m.kind === 'normal' &&
        !m.deleted &&
        !isPendingMessageId(m.id) &&
        m.status !== 'failed'
      ) {
        return m;
      }
    }
    return undefined;
  },
};

/**
 * Creates a memoised render-item selector for one conversation. It only
 * recomputes when the id list, read marker or self id change — never for
 * edits/reactions/receipts, which don't affect layout.
 */
export function createRenderItemsSelector(
  conversationId: ConversationId,
): (s: MessagesState, readMarker: number | undefined, selfId: string | undefined) => RenderItem[] {
  let lastIds: readonly MessageId[] | undefined;
  let lastMarker: number | undefined;
  let lastSelf: string | undefined;
  let lastItems: RenderItem[] = [];
  return (s, readMarker, selfId) => {
    const w = s.windows[conversationId] ?? EMPTY_WINDOW;
    if (w.ids === lastIds && readMarker === lastMarker && selfId === lastSelf) return lastItems;
    lastIds = w.ids;
    lastMarker = readMarker;
    lastSelf = selfId;
    const layout = w.ids.flatMap((id) => {
      const m = w.byId[id];
      return m ? [m] : [];
    });
    lastItems = groupMessages(layout, { readCursor: readMarker, selfId });
    return lastItems;
  };
}
