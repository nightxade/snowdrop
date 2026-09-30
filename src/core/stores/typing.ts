import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationId } from '@/core/domain';

/**
 * Signal clients re-send "typing started" roughly every 10 s while typing and
 * don't always send "stopped" (app closed, network drop), so an indicator
 * must expire on its own. 15 s matches the official clients' behaviour.
 */
export const TYPING_TTL_MS = 15_000;

export interface TypingState {
  /** conversation → author → expiresAt (epoch ms). */
  byConversation: Record<ConversationId, Record<string, number>>;

  setTyping(conversationId: ConversationId, authorId: string, typing: boolean, now: number): void;
  /** Drops expired indicators. Returns the next expiry time, if any remain. */
  prune(now: number): number | undefined;
}

export type TypingStore = StoreApi<TypingState>;

export function createTypingStore(): TypingStore {
  return createStore<TypingState>()((set, get) => ({
    byConversation: {},

    setTyping: (conversationId, authorId, typing, now) => {
      const current = get().byConversation[conversationId] ?? {};
      if (!typing && !(authorId in current)) return;
      const { [authorId]: _previous, ...others } = current;
      const next = typing ? { ...others, [authorId]: now + TYPING_TTL_MS } : others;
      set((s) => ({ byConversation: { ...s.byConversation, [conversationId]: next } }));
    },

    prune: (now) => {
      const state = get().byConversation;
      let changed = false;
      let nextExpiry: number | undefined;
      const out: Record<ConversationId, Record<string, number>> = {};
      for (const [conv, authors] of Object.entries(state) as [
        ConversationId,
        Record<string, number>,
      ][]) {
        const kept: Record<string, number> = {};
        for (const [author, expiresAt] of Object.entries(authors)) {
          if (expiresAt > now) {
            kept[author] = expiresAt;
            nextExpiry = nextExpiry === undefined ? expiresAt : Math.min(nextExpiry, expiresAt);
          } else {
            changed = true;
          }
        }
        if (Object.keys(kept).length > 0) out[conv] = kept;
        else if (Object.keys(authors).length > 0) changed = true;
      }
      if (changed) set({ byConversation: out });
      return nextExpiry;
    },
  }));
}

const NOBODY: readonly string[] = Object.freeze([]);
const typersCache = new WeakMap<Record<string, number>, readonly string[]>();

export const typingSelectors = {
  /**
   * Authors currently typing, sorted for stable rendering. Expiry is enforced
   * by prune() (scheduled by the sync service), so this doesn't need `now`.
   */
  typers:
    (conversationId: ConversationId) =>
    (s: TypingState): readonly string[] => {
      const authors = s.byConversation[conversationId];
      if (!authors) return NOBODY;
      let list = typersCache.get(authors);
      if (!list) {
        list = Object.keys(authors).sort();
        typersCache.set(authors, list);
      }
      return list;
    },
};

/** "Alex is typing…", "Alex and Sam are typing…", "Several people are typing…". */
export function describeTypers(names: readonly string[]): string | null {
  const [a, b] = names;
  if (a === undefined) return null;
  if (b === undefined) return `${a} is typing…`;
  if (names.length === 2) return `${a} and ${b} are typing…`;
  return 'Several people are typing…';
}
