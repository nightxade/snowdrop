/**
 * Device-local state that Signal doesn't carry: pinned / muted / archived
 * conversations, composer drafts and private notes on contacts. Persisted,
 * and deliberately separate from protocol state so a backend update can
 * never clobber it.
 */
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
  conversations: Record<ConversationId, LocalConversationState>;
  /** contactId → private note (profile popout). */
  contactNotes: Record<string, string>;
  /** Demo defaults are applied once per install. */
  seeded: boolean;
}

export interface LocalSeed {
  pinned?: readonly ConversationId[];
  muted?: readonly ConversationId[];
}

export interface LocalState extends LocalData {
  patchConversation(id: ConversationId, patch: Partial<LocalConversationState>): void;
  setPinned(id: ConversationId, pinned: boolean): void;
  setMuted(id: ConversationId, muted: MuteState): void;
  setArchived(id: ConversationId, archived: boolean): void;
  /** Empty/whitespace-only drafts are removed. */
  setDraft(id: ConversationId, draft: string): void;
  /** Empty notes are removed. */
  setNote(contactId: string, note: string): void;
  seedDefaults(seed: LocalSeed): void;
}

export type LocalStore = StoreApi<LocalState>;

export function defaultLocalData(): LocalData {
  return { conversations: {}, contactNotes: {}, seeded: false };
}

export function createLocalStore(initial: LocalData = defaultLocalData()): LocalStore {
  return createStore<LocalState>()((set, get) => ({
    ...initial,

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
    seedDefaults: (seed) => {
      if (get().seeded) return;
      for (const id of seed.pinned ?? []) get().setPinned(id, true);
      for (const id of seed.muted ?? []) get().setMuted(id, true);
      set({ seeded: true });
    },
  }));
}

export const localSelectors = {
  conversations: (s: LocalState) => s.conversations,
  conversation: (id: ConversationId) => (s: LocalState) =>
    s.conversations[id] ?? DEFAULT_LOCAL_CONVERSATION,
  draft: (id: ConversationId) => (s: LocalState) => s.conversations[id]?.draft ?? '',
  note: (contactId: string) => (s: LocalState) => s.contactNotes[contactId] ?? '',
};

export function selectLocalData(s: LocalState): LocalData {
  return { conversations: s.conversations, contactNotes: s.contactNotes, seeded: s.seeded };
}

function parseMute(value: unknown): MuteState {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value.until === 'number') return { until: value.until };
  return false;
}

export const localSchema: VersionedSchema<LocalData> = {
  key: 'hearth.local',
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
    return { conversations, contactNotes, seeded: data.seeded === true };
  },
};
