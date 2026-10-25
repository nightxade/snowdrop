/**
 * Pure list-building for the sidebar and keyboard navigation. Kept out of
 * components so the ordering rules are unit-tested and the Alt+↑/↓ commands
 * walk exactly what the user sees.
 */
import type { ConversationId, ConversationView } from '@/core/domain';
import {
  flattenRail,
  HOME,
  type HomeSection,
  type SpaceSelection,
  type SpacesData,
  type UnreadState,
} from '@/core/stores';

export interface SidebarSection {
  /** HomeSection or a category id. */
  id: string;
  title: string;
  collapsed: boolean;
  /** Everything in the section, in display order. */
  ids: ConversationId[];
  /** How many of the leading `ids` are pinned (0 outside Home). */
  pinnedCount?: number;
}

export const HOME_SECTION_TITLES: Record<HomeSection, string> = {
  conversations: 'Conversations',
  direct: 'Direct Messages',
  groups: 'Groups',
};

export interface HomeLayout {
  /** Separate "Direct Messages" and "Groups" sections instead of one list. */
  splitByType: boolean;
}

/**
 * Home: every DM plus groups not placed in a space. Each section lists its
 * pinned conversations first (in recency order among themselves), then the
 * rest (also by recency). The rest is one list by default, or split into
 * DMs and groups. `views` arrive sorted by last activity (selectors do
 * that), so each bucket inherits the order. Archived conversations are
 * excluded here and listed separately.
 */
export function buildHomeSections(
  views: readonly ConversationView[],
  spaces: Pick<SpacesData, 'spaces' | 'homeCollapsed'>,
  layout: HomeLayout = { splitByType: false },
): SidebarSection[] {
  const allPinned: ConversationId[] = [];
  const allRest: ConversationId[] = [];
  const directPinned: ConversationId[] = [];
  const directRest: ConversationId[] = [];
  const groupsPinned: ConversationId[] = [];
  const groupsRest: ConversationId[] = [];
  const assigned = new Set<string>();
  for (const space of Object.values(spaces.spaces))
    for (const category of space.categories)
      for (const id of category.conversationIds) assigned.add(id);
  const inHome = (v: ConversationView) => v.kind === 'direct' || !assigned.has(v.id);
  for (const view of views) {
    if (view.archived || !inHome(view)) continue;
    if (!layout.splitByType) (view.pinned ? allPinned : allRest).push(view.id);
    else if (view.kind === 'direct') (view.pinned ? directPinned : directRest).push(view.id);
    else (view.pinned ? groupsPinned : groupsRest).push(view.id);
  }
  const section = (
    id: HomeSection,
    pinnedIds: ConversationId[],
    restIds: ConversationId[],
  ): SidebarSection => ({
    id,
    title: HOME_SECTION_TITLES[id],
    collapsed: spaces.homeCollapsed[id],
    ids: [...pinnedIds, ...restIds],
    pinnedCount: pinnedIds.length,
  });
  const sections = layout.splitByType
    ? [section('direct', directPinned, directRest), section('groups', groupsPinned, groupsRest)]
    : [section('conversations', allPinned, allRest)];
  return sections.filter((s) => s.ids.length > 0);
}

export function archivedIds(views: readonly ConversationView[]): ConversationId[] {
  return views.filter((v) => v.archived).map((v) => v.id);
}

/** A space's categories in user order, hiding unknown and archived conversations. */
export function buildSpaceSections(
  spaceId: string,
  spaces: Pick<SpacesData, 'spaces'>,
  known: Readonly<Record<string, { archived?: boolean } | undefined>>,
): SidebarSection[] {
  const space = spaces.spaces[spaceId];
  if (!space) return [];
  return space.categories.map((category) => ({
    id: category.id,
    title: category.name,
    collapsed: category.collapsed,
    ids: category.conversationIds.filter((id) => {
      const view = known[id];
      return view !== undefined && !view.archived;
    }),
  }));
}

/**
 * Rows actually rendered for a section. A collapsed section still shows its
 * pinned rows, the open conversation, and anything unread, so collapsing
 * never hides what's pinned, where you are, or what needs attention.
 */
export function visibleIds(
  section: SidebarSection,
  selected: ConversationId | null,
  unread: Readonly<Record<string, UnreadState | undefined>>,
): ConversationId[] {
  if (!section.collapsed) return section.ids;
  const pinnedCount = section.pinnedCount ?? 0;
  return section.ids.filter(
    (id, i) => i < pinnedCount || id === selected || (unread[id]?.count ?? 0) > 0,
  );
}

/** The flat, rendered order of rows (what Alt+↑/↓ walks). */
export function navigationOrder(
  sections: readonly SidebarSection[],
  selected: ConversationId | null,
  unread: Readonly<Record<string, UnreadState | undefined>>,
): ConversationId[] {
  return sections.flatMap((s) => visibleIds(s, selected, unread));
}

/** Previous/next conversation relative to `current`; clamps at the ends. */
export function stepConversation(
  order: readonly ConversationId[],
  current: ConversationId | null,
  delta: 1 | -1,
): ConversationId | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index === -1) return delta === 1 ? (order[0] ?? null) : (order.at(-1) ?? null);
  return order[Math.max(0, Math.min(order.length - 1, index + delta))] ?? null;
}

export interface Location {
  space: SpaceSelection;
  id: ConversationId;
}

/**
 * Every conversation across Home and the spaces, in rail order, for the
 * "next unread" command. Collapse state is ignored: an unread conversation
 * in a collapsed category is still worth jumping to.
 */
export function globalOrder(
  homeSections: readonly SidebarSection[],
  spaces: Pick<SpacesData, 'spaces' | 'rail'>,
  known: Readonly<Record<string, { archived?: boolean } | undefined>>,
): Location[] {
  const out: Location[] = homeSections.flatMap((s) => s.ids.map((id) => ({ space: HOME, id })));
  for (const spaceId of flattenRail(spaces.rail)) {
    for (const section of buildSpaceSections(spaceId, spaces, known)) {
      for (const id of section.ids) out.push({ space: spaceId, id });
    }
  }
  return out;
}

/** Whether a conversation deserves a "next unread" stop: unread (or marked unread) and not muted, or mentioned. */
export function wantsAttention(
  unread: UnreadState | undefined,
  muted: boolean,
  markedUnread = false,
): boolean {
  if (markedUnread && !muted) return true;
  if (!unread) return false;
  return unread.mentions > 0 || (unread.count > 0 && !muted);
}

export function stepUnread(
  order: readonly Location[],
  current: Location | null,
  delta: 1 | -1,
  attention: (id: ConversationId) => boolean,
): Location | null {
  const n = order.length;
  if (n === 0) return null;
  const start = current
    ? order.findIndex((l) => l.id === current.id && l.space === current.space)
    : -1;
  // With no current position, walking backwards starts from the end.
  const origin = start === -1 && delta === -1 ? n : start;
  for (let step = 1; step <= n; step++) {
    const index = (((origin + step * delta) % n) + n) % n;
    const candidate = order[index];
    if (candidate && !(current && candidate.id === current.id) && attention(candidate.id)) {
      return candidate;
    }
  }
  return null;
}
