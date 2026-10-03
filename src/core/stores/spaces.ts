/**
 * Spaces: purely local organisation of Signal conversations.
 *
 * Signal has no concept of servers/channels. Spaces let the user group their
 * Signal groups into community-style collections with categories, on this device
 * only. A conversation belongs to at most one space; DMs still appear in Home
 * even when also placed in a space (Home is "everything personal").
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationId } from '@/core/domain';
import { createNonce } from '@/core/lib';
import { isRecord, type VersionedSchema } from '@/core/persistence';

export type SpaceId = string;

export interface Category {
  id: string;
  name: string;
  collapsed: boolean;
  conversationIds: ConversationId[];
}

export interface Space {
  id: SpaceId;
  name: string;
  emoji?: string;
  /** Avatar hue slot 1..12 (rendered via --snowdrop-avatar-N). */
  hue: number;
  muted: boolean;
  categories: Category[];
}

export type RailEntry =
  | { type: 'space'; id: SpaceId }
  | {
      type: 'folder';
      id: string;
      name: string;
      collapsed: boolean;
      spaceIds: SpaceId[];
      /** Avatar hue slot 1..12 tinting the folder; absent = neutral. */
      hue?: number;
    };

export type HomeSection = 'pinned' | 'direct' | 'groups';

export interface SpacesData {
  spaces: Record<SpaceId, Space>;
  rail: RailEntry[];
  homeCollapsed: Record<HomeSection, boolean>;
  /** Default spaces are created once per install, never re-added after deletion. */
  seeded: boolean;
}

export interface SpaceInput {
  name: string;
  emoji?: string;
  hue?: number;
  conversationIds?: readonly ConversationId[];
}

export interface SpaceSeedInput {
  name: string;
  emoji?: string;
  categories: { name: string; conversationIds: readonly ConversationId[] }[];
}

export interface SpacesState extends SpacesData {
  createSpace(input: SpaceInput): SpaceId;
  updateSpace(id: SpaceId, patch: Partial<Pick<Space, 'name' | 'emoji' | 'hue' | 'muted'>>): void;
  /** Deletes a space; its conversations return to Home. */
  deleteSpace(id: SpaceId): void;
  /** Moves a conversation into a space (first category unless specified). */
  assign(conversationId: ConversationId, spaceId: SpaceId, categoryId?: string): void;
  unassign(conversationId: ConversationId): void;
  /** Reorders/moves a conversation to `index` within a category of its space. */
  moveConversation(conversationId: ConversationId, categoryId: string, index: number): void;
  addCategory(spaceId: SpaceId, name: string): string | null;
  renameCategory(spaceId: SpaceId, categoryId: string, name: string): void;
  /** Removes a category; its conversations move to the first remaining one. The last category can't be removed. */
  removeCategory(spaceId: SpaceId, categoryId: string): boolean;
  toggleCategory(spaceId: SpaceId, categoryId: string): void;
  moveRailEntry(from: number, to: number): void;
  /** Drag `dragged` onto `target`: creates a folder at target's position (or joins target's folder). */
  createFolder(targetSpaceId: SpaceId, draggedSpaceId: SpaceId, name?: string): string | null;
  removeFromFolder(spaceId: SpaceId): void;
  toggleFolder(folderId: string): void;
  renameFolder(folderId: string, name: string): void;
  /** null clears the tint. */
  setFolderHue(folderId: string, hue: number | null): void;
  /** Replaces the folder by its spaces, in order, at the folder's position. */
  dissolveFolder(folderId: string): void;
  /**
   * Moves a top-level space or folder so it sits before/after another rail
   * entry (by entry id). Spaces inside folders are taken out first.
   */
  placeRailEntry(entryId: string, targetId: string, position: 'before' | 'after'): void;
  /** Moves a category to `index` within its space. */
  moveCategory(spaceId: SpaceId, categoryId: string, index: number): void;
  toggleHomeSection(section: HomeSection): void;
  seedDefaults(seeds: readonly SpaceSeedInput[]): void;
}

export type SpacesStore = StoreApi<SpacesState>;

export const DEFAULT_CATEGORY_NAME = 'Chats';

export function defaultSpacesData(): SpacesData {
  return {
    spaces: {},
    rail: [],
    homeCollapsed: { pinned: false, direct: false, groups: false },
    seeded: false,
  };
}

// ─── Pure helpers (exported for tests & selectors) ────────────────────────

function withoutConversation(space: Space, conversationId: ConversationId): Space {
  if (!space.categories.some((c) => c.conversationIds.includes(conversationId))) return space;
  return {
    ...space,
    categories: space.categories.map((c) =>
      c.conversationIds.includes(conversationId)
        ? { ...c, conversationIds: c.conversationIds.filter((x) => x !== conversationId) }
        : c,
    ),
  };
}

function removeEverywhere(
  spaces: Record<SpaceId, Space>,
  conversationId: ConversationId,
): Record<SpaceId, Space> {
  const out: Record<SpaceId, Space> = {};
  for (const [id, space] of Object.entries(spaces))
    out[id] = withoutConversation(space, conversationId);
  return out;
}

function railWithout(rail: readonly RailEntry[], spaceId: SpaceId): RailEntry[] {
  const out: RailEntry[] = [];
  for (const entry of rail) {
    if (entry.type === 'space') {
      if (entry.id !== spaceId) out.push(entry);
      continue;
    }
    const spaceIds = entry.spaceIds.filter((id) => id !== spaceId);
    // A folder of one is just a space.
    const [only] = spaceIds;
    if (spaceIds.length === 1 && only !== undefined) out.push({ type: 'space', id: only });
    else if (spaceIds.length > 1) out.push({ ...entry, spaceIds });
  }
  return out;
}

export function flattenRail(rail: readonly RailEntry[]): SpaceId[] {
  return rail.flatMap((e) => (e.type === 'space' ? [e.id] : e.spaceIds));
}

function clampHue(hue: number): number {
  return Number.isInteger(hue) && hue >= 1 && hue <= 12 ? hue : 1;
}

export function createSpacesStore(
  initial: SpacesData = defaultSpacesData(),
  newId: (prefix: string) => string = createNonce,
): SpacesStore {
  return createStore<SpacesState>()((set, get) => {
    const patchSpace = (id: SpaceId, fn: (space: Space) => Space): void => {
      const space = get().spaces[id];
      if (!space) return;
      const next = fn(space);
      if (next !== space) set((s) => ({ spaces: { ...s.spaces, [id]: next } }));
    };

    return {
      ...initial,

      createSpace: (input) => {
        const id = newId('space');
        const conversationIds = [...new Set(input.conversationIds ?? [])];
        let spaces = get().spaces;
        for (const c of conversationIds) spaces = removeEverywhere(spaces, c);
        const space: Space = {
          id,
          name: input.name.trim() || 'New space',
          hue: clampHue(input.hue ?? (Object.keys(spaces).length % 12) + 1),
          muted: false,
          categories: [
            { id: newId('cat'), name: DEFAULT_CATEGORY_NAME, collapsed: false, conversationIds },
          ],
        };
        if (input.emoji) space.emoji = input.emoji;
        set((s) => ({
          spaces: { ...spaces, [id]: space },
          rail: [...s.rail, { type: 'space', id }],
        }));
        return id;
      },

      updateSpace: (id, patch) => {
        patchSpace(id, (space) => {
          const next = { ...space, ...patch };
          if (patch.name !== undefined) next.name = patch.name.trim() || space.name;
          if (patch.hue !== undefined) next.hue = clampHue(patch.hue);
          // An empty emoji clears it (the tile falls back to initials).
          if (patch.emoji === '') delete next.emoji;
          return next;
        });
      },

      deleteSpace: (id) => {
        if (!get().spaces[id]) return;
        set((s) => {
          const { [id]: _deleted, ...spaces } = s.spaces;
          return { spaces, rail: railWithout(s.rail, id) };
        });
      },

      assign: (conversationId, spaceId, categoryId) => {
        const target = get().spaces[spaceId];
        if (!target) return;
        const spaces = removeEverywhere(get().spaces, conversationId);
        const cleaned = spaces[spaceId] as Space;
        const category =
          cleaned.categories.find((c) => c.id === categoryId) ?? cleaned.categories[0];
        if (!category) return;
        spaces[spaceId] = {
          ...cleaned,
          categories: cleaned.categories.map((c) =>
            c === category ? { ...c, conversationIds: [...c.conversationIds, conversationId] } : c,
          ),
        };
        set({ spaces });
      },

      unassign: (conversationId) => {
        set((s) => ({ spaces: removeEverywhere(s.spaces, conversationId) }));
      },

      moveConversation: (conversationId, categoryId, index) => {
        const owner = Object.values(get().spaces).find((sp) =>
          sp.categories.some((c) => c.id === categoryId),
        );
        if (!owner) return;
        // Removing it everywhere first also handles moves between spaces.
        const spaces = removeEverywhere(get().spaces, conversationId);
        const cleaned = spaces[owner.id] as Space;
        spaces[owner.id] = {
          ...cleaned,
          categories: cleaned.categories.map((c) => {
            if (c.id !== categoryId) return c;
            const ids = [...c.conversationIds];
            ids.splice(Math.max(0, Math.min(index, ids.length)), 0, conversationId);
            return { ...c, conversationIds: ids };
          }),
        };
        set({ spaces });
      },

      addCategory: (spaceId, name) => {
        if (!get().spaces[spaceId]) return null;
        const id = newId('cat');
        patchSpace(spaceId, (space) => ({
          ...space,
          categories: [
            ...space.categories,
            { id, name: name.trim() || 'New category', collapsed: false, conversationIds: [] },
          ],
        }));
        return id;
      },

      renameCategory: (spaceId, categoryId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        patchSpace(spaceId, (space) => ({
          ...space,
          categories: space.categories.map((c) =>
            c.id === categoryId ? { ...c, name: trimmed } : c,
          ),
        }));
      },

      removeCategory: (spaceId, categoryId) => {
        const space = get().spaces[spaceId];
        if (!space || space.categories.length <= 1) return false;
        const removed = space.categories.find((c) => c.id === categoryId);
        if (!removed) return false;
        const rest = space.categories.filter((c) => c !== removed);
        const [first, ...others] = rest as [Category, ...Category[]];
        patchSpace(spaceId, () => ({
          ...space,
          categories: [
            { ...first, conversationIds: [...first.conversationIds, ...removed.conversationIds] },
            ...others,
          ],
        }));
        return true;
      },

      toggleCategory: (spaceId, categoryId) => {
        patchSpace(spaceId, (space) => ({
          ...space,
          categories: space.categories.map((c) =>
            c.id === categoryId ? { ...c, collapsed: !c.collapsed } : c,
          ),
        }));
      },

      moveRailEntry: (from, to) => {
        const rail = [...get().rail];
        if (from < 0 || from >= rail.length || from === to) return;
        const [entry] = rail.splice(from, 1);
        rail.splice(Math.max(0, Math.min(to, rail.length)), 0, entry as RailEntry);
        set({ rail });
      },

      createFolder: (targetSpaceId, draggedSpaceId, name = 'Folder') => {
        const { rail, spaces } = get();
        if (targetSpaceId === draggedSpaceId || !spaces[targetSpaceId] || !spaces[draggedSpaceId]) {
          return null;
        }
        const withoutDragged = railWithout(rail, draggedSpaceId);
        const index = withoutDragged.findIndex((e) =>
          e.type === 'space' ? e.id === targetSpaceId : e.spaceIds.includes(targetSpaceId),
        );
        const target = withoutDragged[index];
        if (!target) return null;
        if (target.type === 'folder') {
          withoutDragged[index] = { ...target, spaceIds: [...target.spaceIds, draggedSpaceId] };
          set({ rail: withoutDragged });
          return target.id;
        }
        const id = newId('folder');
        withoutDragged[index] = {
          type: 'folder',
          id,
          name,
          collapsed: false,
          spaceIds: [targetSpaceId, draggedSpaceId],
        };
        set({ rail: withoutDragged });
        return id;
      },

      removeFromFolder: (spaceId) => {
        const rail = get().rail;
        const index = rail.findIndex((e) => e.type === 'folder' && e.spaceIds.includes(spaceId));
        if (index === -1) return;
        const next = railWithout(rail, spaceId);
        // Place it right after where the folder was.
        next.splice(Math.min(index + 1, next.length), 0, { type: 'space', id: spaceId });
        set({ rail: next });
      },

      toggleFolder: (folderId) => {
        set((s) => ({
          rail: s.rail.map((e) =>
            e.type === 'folder' && e.id === folderId ? { ...e, collapsed: !e.collapsed } : e,
          ),
        }));
      },

      renameFolder: (folderId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((s) => ({
          rail: s.rail.map((e) =>
            e.type === 'folder' && e.id === folderId ? { ...e, name: trimmed.slice(0, 40) } : e,
          ),
        }));
      },

      setFolderHue: (folderId, hue) => {
        set((s) => ({
          rail: s.rail.map((e) => {
            if (e.type !== 'folder' || e.id !== folderId) return e;
            const { hue: _old, ...rest } = e;
            return hue === null ? rest : { ...rest, hue: clampHue(hue) };
          }),
        }));
      },

      dissolveFolder: (folderId) => {
        set((s) => ({
          rail: s.rail.flatMap((e): RailEntry[] =>
            e.type === 'folder' && e.id === folderId
              ? e.spaceIds.map((id) => ({ type: 'space', id }))
              : [e],
          ),
        }));
      },

      placeRailEntry: (entryId, targetId, position) => {
        if (entryId === targetId) return;
        const { rail } = get();
        const top = rail.find((e) => e.id === entryId);
        let moving: RailEntry;
        let rest: RailEntry[];
        if (top) {
          moving = top;
          rest = rail.filter((e) => e !== top);
        } else if (rail.some((e) => e.type === 'folder' && e.spaceIds.includes(entryId))) {
          moving = { type: 'space', id: entryId };
          rest = railWithout(rail, entryId);
        } else return;
        // Dissolving a folder of two can turn the target into a plain space entry with the same id.
        const index = rest.findIndex(
          (e) => e.id === targetId || (e.type === 'folder' && e.spaceIds.includes(targetId)),
        );
        if (index === -1) return;
        rest.splice(position === 'before' ? index : index + 1, 0, moving);
        set({ rail: rest });
      },

      moveCategory: (spaceId, categoryId, index) => {
        patchSpace(spaceId, (space) => {
          const from = space.categories.findIndex((c) => c.id === categoryId);
          if (from === -1) return space;
          const categories = [...space.categories];
          const [moved] = categories.splice(from, 1);
          categories.splice(Math.max(0, Math.min(index, categories.length)), 0, moved as Category);
          return { ...space, categories };
        });
      },

      toggleHomeSection: (section) => {
        set((s) => ({
          homeCollapsed: { ...s.homeCollapsed, [section]: !s.homeCollapsed[section] },
        }));
      },

      seedDefaults: (seeds) => {
        if (get().seeded) return;
        for (const seed of seeds) {
          const input: SpaceInput = { name: seed.name };
          if (seed.emoji) input.emoji = seed.emoji;
          const id = get().createSpace(input);
          const [first, ...rest] = seed.categories;
          patchSpace(id, (space) => {
            const base = space.categories[0] as Category;
            return {
              ...space,
              categories: [
                {
                  ...base,
                  name: first?.name ?? base.name,
                  conversationIds: [...(first?.conversationIds ?? [])],
                },
                ...rest.map((c) => ({
                  id: newId('cat'),
                  name: c.name,
                  collapsed: false,
                  conversationIds: [...c.conversationIds],
                })),
              ],
            };
          });
        }
        set({ seeded: true });
      },
    };
  });
}

// ─── Selectors ────────────────────────────────────────────────────────────

const spaceIndexCache = new WeakMap<Record<SpaceId, Space>, Map<ConversationId, SpaceId>>();

function spaceIndex(spaces: Record<SpaceId, Space>): Map<ConversationId, SpaceId> {
  let index = spaceIndexCache.get(spaces);
  if (!index) {
    index = new Map();
    for (const space of Object.values(spaces)) {
      for (const c of space.categories) for (const id of c.conversationIds) index.set(id, space.id);
    }
    spaceIndexCache.set(spaces, index);
  }
  return index;
}

const orderCache = new WeakMap<readonly RailEntry[], SpaceId[]>();

export const spacesSelectors = {
  spaces: (s: SpacesState) => s.spaces,
  space: (id: SpaceId) => (s: SpacesState) => s.spaces[id],
  rail: (s: SpacesState) => s.rail,
  /** Space ids in rail order (folders flattened); memoised. */
  orderedIds: (s: SpacesState): SpaceId[] => {
    let ids = orderCache.get(s.rail);
    if (!ids) {
      ids = flattenRail(s.rail);
      orderCache.set(s.rail, ids);
    }
    return ids;
  },
  spaceOf:
    (conversationId: ConversationId) =>
    (s: SpacesState): SpaceId | null =>
      spaceIndex(s.spaces).get(conversationId) ?? null,
  /**
   * Category entries whose conversation is currently known. Assignments are
   * never pruned automatically — a partial conversation list (still syncing,
   * backend hiccup) must not wipe the user's organisation — orphans are just
   * hidden until the conversation reappears.
   */
  visibleConversationIds: (
    category: Category,
    known: Readonly<Record<string, unknown>>,
  ): ConversationId[] => category.conversationIds.filter((id) => id in known),
  /** Home shows every DM plus groups not assigned to any space. */
  isInHome:
    (conversationId: ConversationId, kind: 'direct' | 'group') =>
    (s: SpacesState): boolean =>
      kind === 'direct' || !spaceIndex(s.spaces).has(conversationId),
};

// ─── Persistence schema ───────────────────────────────────────────────────

function parseCategory(value: unknown): Category | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    return null;
  const ids = Array.isArray(value.conversationIds)
    ? value.conversationIds.filter((x): x is ConversationId => typeof x === 'string')
    : [];
  return {
    id: value.id,
    name: value.name,
    collapsed: value.collapsed === true,
    conversationIds: ids,
  };
}

function parseSpace(value: unknown): Space | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    return null;
  const categories = Array.isArray(value.categories)
    ? value.categories.map(parseCategory).filter((c): c is Category => c !== null)
    : [];
  if (categories.length === 0) return null;
  const space: Space = {
    id: value.id,
    name: value.name,
    hue: clampHue(typeof value.hue === 'number' ? value.hue : 1),
    muted: value.muted === true,
    categories,
  };
  if (typeof value.emoji === 'string') space.emoji = value.emoji;
  return space;
}

function parseRailEntry(value: unknown, spaces: Record<SpaceId, Space>): RailEntry | null {
  if (!isRecord(value)) return null;
  if (value.type === 'space' && typeof value.id === 'string' && spaces[value.id]) {
    return { type: 'space', id: value.id };
  }
  if (value.type === 'folder' && typeof value.id === 'string' && Array.isArray(value.spaceIds)) {
    const spaceIds = value.spaceIds.filter(
      (x): x is string => typeof x === 'string' && !!spaces[x],
    );
    if (spaceIds.length === 0) return null;
    const folder: RailEntry = {
      type: 'folder',
      id: value.id,
      name: typeof value.name === 'string' ? value.name : 'Folder',
      collapsed: value.collapsed === true,
      spaceIds,
    };
    if (typeof value.hue === 'number') folder.hue = clampHue(value.hue);
    return folder;
  }
  return null;
}

export const spacesSchema: VersionedSchema<SpacesData> = {
  key: 'snowdrop.spaces',
  version: 1,
  defaults: defaultSpacesData,
  parse: (data) => {
    if (!isRecord(data)) return null;
    const spaces: Record<SpaceId, Space> = {};
    // Restore invariants hand-edited or buggy data may break: a conversation
    // lives in at most one category, ids are unique, each space appears once
    // on the rail.
    const seenConversations = new Set<ConversationId>();
    const seenCategories = new Set<string>();
    if (isRecord(data.spaces)) {
      for (const raw of Object.values(data.spaces)) {
        const space = parseSpace(raw);
        if (!space || spaces[space.id]) continue;
        const categories = space.categories
          .filter((c) => !seenCategories.has(c.id) && (seenCategories.add(c.id), true))
          .map((c) => ({
            ...c,
            conversationIds: c.conversationIds.filter(
              (id) => !seenConversations.has(id) && (seenConversations.add(id), true),
            ),
          }));
        if (categories.length === 0) continue;
        spaces[space.id] = { ...space, categories };
      }
    }
    const onRail = new Set<SpaceId>();
    const rail: RailEntry[] = [];
    if (Array.isArray(data.rail)) {
      for (const raw of data.rail) {
        const entry = parseRailEntry(raw, spaces);
        if (!entry) continue;
        if (entry.type === 'space') {
          if (onRail.has(entry.id)) continue;
          onRail.add(entry.id);
          rail.push(entry);
        } else {
          const spaceIds = entry.spaceIds.filter((id) => !onRail.has(id) && (onRail.add(id), true));
          const [only] = spaceIds;
          if (spaceIds.length === 1 && only !== undefined) rail.push({ type: 'space', id: only });
          else if (spaceIds.length > 1) rail.push({ ...entry, spaceIds });
        }
      }
    }
    // Any space missing from the rail is appended so it can't become unreachable.
    for (const id of Object.keys(spaces)) if (!onRail.has(id)) rail.push({ type: 'space', id });
    const home = isRecord(data.homeCollapsed) ? data.homeCollapsed : {};
    return {
      spaces,
      rail,
      homeCollapsed: {
        pinned: home.pinned === true,
        direct: home.direct === true,
        groups: home.groups === true,
      },
      seeded: data.seeded === true,
    };
  },
};

export function selectSpacesData(s: SpacesState): SpacesData {
  return { spaces: s.spaces, rail: s.rail, homeCollapsed: s.homeCollapsed, seeded: s.seeded };
}
