/**
 * Device-local state that Signal doesn't carry: pinned / muted / archived
 * conversations, composer drafts and private notes on contacts. Persisted,
 * and deliberately separate from protocol state so a backend update can
 * never clobber it.
 */
import { parseCustomEmoji, parseCustomEmojiLibrary, type CustomEmoji } from './customEmoji';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  asConversationId,
  type ConversationId,
  type LocalConversationState,
  type MuteState,
} from '@/core/domain';
import { isRecord, type VersionedSchema } from '@/core/persistence';

export const DEFAULT_LOCAL_CONVERSATION: LocalConversationState = Object.freeze({
  pinned: false,
  muted: false,
  archived: false,
});

export interface LocalData {
  /** Personal image emoji, scoped to this backend/account with the rest of local data. */
  customEmoji: CustomEmoji[];
  conversations: Record<ConversationId, LocalConversationState>;
  /** contactId → private note (profile popout). */
  contactNotes: Record<string, string>;
  /** emoji → times used for a reaction; the hover bar offers the most used. */
  reactionUsage: Record<string, number>;
  /** Demo defaults are applied once per install. */
  seeded: boolean;
}

export interface LocalSeed {
  pinned?: readonly ConversationId[];
  muted?: readonly ConversationId[];
}

export interface LocalState extends LocalData {
  saveCustomEmoji(emoji: CustomEmoji): void;
  removeCustomEmoji(name: string): void;
  patchConversation(id: ConversationId, patch: Partial<LocalConversationState>): void;
  setPinned(id: ConversationId, pinned: boolean): void;
  setMuted(id: ConversationId, muted: MuteState): void;
  setArchived(id: ConversationId, archived: boolean): void;
  /** Empty/whitespace-only drafts are removed. */
  setDraft(id: ConversationId, draft: string): void;
  /** Empty notes are removed. */
  setNote(contactId: string, note: string): void;
  noteReactionUsed(emoji: string): void;
  seedDefaults(seed: LocalSeed): void;
}

export type LocalStore = StoreApi<LocalState>;

export function defaultLocalData(): LocalData {
  return { customEmoji: [], conversations: {}, contactNotes: {}, reactionUsage: {}, seeded: false };
}

export function createLocalStore(initial: LocalData = defaultLocalData()): LocalStore {
  return createStore<LocalState>()((set, get) => ({
    ...initial,
    saveCustomEmoji: (value) => {
      const emoji = parseCustomEmoji(value);
      if (!emoji)
        throw new Error('Use a valid image and a name with 1–32 letters, numbers, +, - or _.');
      const current = get().customEmoji;
      const index = current.findIndex((item) => item.name === emoji.name);
      const next = [...current];
      if (index < 0) next.push(emoji);
      else next[index] = emoji;
      if (parseCustomEmojiLibrary(next).length !== next.length) {
        throw new Error('Your emoji collection is full. Remove an emoji before adding another.');
      }
      set({ customEmoji: next });
    },
    removeCustomEmoji: (name) => {
      set((s) => ({ customEmoji: s.customEmoji.filter((emoji) => emoji.name !== name) }));
    },

    patchConversation: (id, patch) => {
      set((s) => {
        const current = s.conversations[id] ?? DEFAULT_LOCAL_CONVERSATION;
        const next: LocalConversationState = { ...current, ...patch };
        if (patch.draft !== undefined && patch.draft.trim() === '') delete next.draft;
        return { conversations: { ...s.conversations, [id]: next } };
      });
    },
    setPinned: (id, pinned) => {
      get().patchConversation(id, { pinned });
    },
    setMuted: (id, muted) => {
      get().patchConversation(id, { muted });
    },
    setArchived: (id, archived) => {
      get().patchConversation(id, { archived });
    },
    setDraft: (id, draft) => {
      const current = get().conversations[id]?.draft ?? '';
      if (current === draft || (current === '' && draft.trim() === '')) return;
      get().patchConversation(id, { draft });
    },
    setNote: (contactId, note) => {
      set((s) => {
        const { [contactId]: _previous, ...rest } = s.contactNotes;
        return { contactNotes: note.trim() === '' ? rest : { ...rest, [contactId]: note } };
      });
    },
    noteReactionUsed: (emoji) => {
      set((s) => {
        const usage = { ...s.reactionUsage, [emoji]: (s.reactionUsage[emoji] ?? 0) + 1 };
        // Keep the map small: only the most used survive.
        const kept = Object.entries(usage)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_TRACKED_REACTIONS);
        return { reactionUsage: Object.fromEntries(kept) };
      });
    },
    seedDefaults: (seed) => {
      if (get().seeded) return;
      for (const id of seed.pinned ?? []) get().setPinned(id, true);
      for (const id of seed.muted ?? []) get().setMuted(id, true);
      set({ seeded: true });
    },
  }));
}

const MAX_TRACKED_REACTIONS = 24;
/** Offered before the user has reacted enough for a personal top list. */
export const DEFAULT_QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂'];

const quickCache = new WeakMap<Record<string, number>, readonly string[]>();

export const localSelectors = {
  conversations: (s: LocalState) => s.conversations,
  conversation: (id: ConversationId) => (s: LocalState) =>
    s.conversations[id] ?? DEFAULT_LOCAL_CONVERSATION,
  draft: (id: ConversationId) => (s: LocalState) => s.conversations[id]?.draft ?? '',
  note: (contactId: string) => (s: LocalState) => s.contactNotes[contactId] ?? '',
  /** The three most used reactions, topped up with defaults. Stable per usage map. */
  quickReactions: (s: LocalState): readonly string[] => {
    let list = quickCache.get(s.reactionUsage);
    if (!list) {
      const used = Object.entries(s.reactionUsage)
        .sort((a, b) => b[1] - a[1])
        .map(([emoji]) => emoji);
      list = [...new Set([...used, ...DEFAULT_QUICK_REACTIONS])].slice(0, 3);
      quickCache.set(s.reactionUsage, list);
    }
    return list;
  },
};

export function selectLocalData(s: LocalState): LocalData {
  return {
    customEmoji: s.customEmoji,
    conversations: s.conversations,
    contactNotes: s.contactNotes,
    reactionUsage: s.reactionUsage,
    seeded: s.seeded,
  };
}

/**
 * Folds `incoming` into `existing` the same way `mergeSpacesData` does (see
 * there): `existing` wins on a key conflict, anything only `incoming` has
 * is added. Reaction counts are summed rather than overwritten, then
 * re-trimmed to the same cap `noteReactionUsed` keeps.
 */
export function mergeLocalData(existing: LocalData, incoming: LocalData): LocalData {
  const reactionUsage: Record<string, number> = { ...incoming.reactionUsage };
  for (const [emoji, count] of Object.entries(existing.reactionUsage)) {
    reactionUsage[emoji] = (reactionUsage[emoji] ?? 0) + count;
  }
  const trimmed = Object.fromEntries(
    Object.entries(reactionUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TRACKED_REACTIONS),
  );
  return {
    customEmoji: parseCustomEmojiLibrary([...existing.customEmoji, ...incoming.customEmoji]),
    conversations: { ...incoming.conversations, ...existing.conversations },
    contactNotes: { ...incoming.contactNotes, ...existing.contactNotes },
    reactionUsage: trimmed,
    seeded: existing.seeded || incoming.seeded,
  };
}

function parseMute(value: unknown): MuteState {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value.until === 'number') return { until: value.until };
  return false;
}

export const localSchema: VersionedSchema<LocalData> = {
  key: 'snowdrop.local',
  version: 1,
  defaults: defaultLocalData,
  parse: (data) => {
    if (!isRecord(data)) return null;
    const conversations: Record<ConversationId, LocalConversationState> = {};
    if (isRecord(data.conversations)) {
      for (const [key, raw] of Object.entries(data.conversations)) {
        const id = asConversationId(key);
        if (!id || !isRecord(raw)) continue;
        const entry: LocalConversationState = {
          pinned: raw.pinned === true,
          muted: parseMute(raw.muted),
          archived: raw.archived === true,
        };
        if (typeof raw.draft === 'string' && raw.draft.trim() !== '') entry.draft = raw.draft;
        conversations[id] = entry;
      }
    }
    const contactNotes: Record<string, string> = {};
    if (isRecord(data.contactNotes)) {
      for (const [id, note] of Object.entries(data.contactNotes)) {
        if (typeof note === 'string' && note.trim() !== '') contactNotes[id] = note;
      }
    }
    const reactionUsage: Record<string, number> = {};
    if (isRecord(data.reactionUsage)) {
      for (const [emoji, count] of Object.entries(data.reactionUsage)) {
        if (typeof count === 'number' && Number.isFinite(count) && count > 0 && emoji.length <= 32)
          reactionUsage[emoji] = count;
      }
    }
    return {
      customEmoji: parseCustomEmojiLibrary(data.customEmoji),
      conversations,
      contactNotes,
      reactionUsage,
      seeded: data.seeded === true,
    };
  },
};
