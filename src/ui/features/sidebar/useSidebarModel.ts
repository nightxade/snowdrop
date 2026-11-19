import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, ConversationView } from '@/core/domain';
import {
  attentionOf,
  HOME,
  isMuted,
  needsAttention,
  selectConversationViews,
  sessionSelectors,
  uiSelectors,
  type SpaceSelection,
  type SpacesData,
  type Stores,
} from '@/core/stores';
import { useCatchUpShelf, useFrozenWhile, useNow, useStores } from '@/ui/hooks';
import {
  archivedIds,
  buildHomeSections,
  buildSpaceSections,
  globalOrder,
  navigationOrder,
  type HomeLayout,
  type Location,
  type SidebarSection,
} from './model';

export interface SidebarModel {
  space: SpaceSelection;
  sections: SidebarSection[];
  archived: ConversationId[];
  selected: ConversationId | null;
  /** While catching up (PLAN): order and badges hold still; see `useFrozenOrder`. */
  catchingUp: boolean;
  /**
   * Whether a row shows an indicator (a dot, a count or a mention): the same
   * rule as the row's own badge, held still during catch-up like it. A
   * collapsed section keeps exactly these rows visible.
   */
  attention: (id: ConversationId) => boolean;
}

function indexViews(views: readonly ConversationView[]): Record<string, ConversationView> {
  const out: Record<string, ConversationView> = {};
  for (const v of views) out[v.id] = v;
  return out;
}

function homeLayout(stores: Stores): HomeLayout {
  return { splitByType: stores.settings.getState().appearance.splitHomeByType };
}

/**
 * A frozen view with what the user chose here since the freeze: pinned, archived and muted come
 * from the live view, so Pin to top, Archive and the rest apply at once (S1). Recency, kind and the
 * rest stay frozen. A chat that came back from the archive because something arrived in it (the
 * live view has newer activity) is that arrival and stays held, like any other.
 */
function withOwnChoices(frozen: ConversationView, live: ConversationView): ConversationView {
  const arrivedBack =
    frozen.archived &&
    !live.archived &&
    !live.pinned &&
    live.lastActivityAt !== frozen.lastActivityAt;
  return {
    ...frozen,
    pinned: live.pinned,
    muted: live.muted,
    archived: arrivedBack ? true : live.archived,
  };
}

/**
 * While catching up, every conversation seen before it started keeps its
 * frozen view (so its position and whatever `buildHomeSections`/
 * `buildSpaceSections` derive from it — kind, recency order — hold still),
 * except what the user chose here meanwhile (`withOwnChoices`); a
 * conversation that didn't exist yet is new activity and still surfaces,
 * ahead of the frozen ones.
 */
function useFrozenOrder(
  live: readonly ConversationView[],
  catchingUp: boolean,
): readonly ConversationView[] {
  // Ready once conversations exist: the first catch-up can start before they have loaded.
  const shelf = useCatchUpShelf();
  const frozen = useFrozenWhile(live, catchingUp, live.length > 0, { shelf, key: 'order' });
  if (!catchingUp) return live;
  const liveById = new Map(live.map((v) => [v.id, v]));
  const frozenIds = new Set(frozen.map((v) => v.id));
  const fresh = live.filter((v) => !frozenIds.has(v.id));
  const stillPresent = frozen.flatMap((v) => {
    const now = liveById.get(v.id);
    return now ? [withOwnChoices(v, now)] : [];
  });
  return fresh.length > 0 ? [...fresh, ...stillPresent] : stillPresent;
}

function sectionsFor(
  space: SpaceSelection,
  views: readonly ConversationView[],
  spaces: SpacesData,
  layout: HomeLayout,
): SidebarSection[] {
  return space === HOME
    ? buildHomeSections(views, spaces, layout)
    : buildSpaceSections(space, spaces, indexViews(views));
}

/** Which conversations have anything unread or mentioned, as `\tflags` (count, mentions) per id. */
function unreadFlags(
  unread: Readonly<Record<string, { count: number; mentions: number }>>,
): string {
  return Object.entries(unread)
    .filter(([, u]) => u.count > 0 || u.mentions > 0)
    .map(([id, u]) => `${id}\t${u.count > 0 ? 1 : 0}${u.mentions > 0 ? 1 : 0}`)
    .sort()
    .join('\n');
}

function parseFlags(text: string): Map<string, { count: number; mentions: number }> {
  const map = new Map<string, { count: number; mentions: number }>();
  for (const line of text ? text.split('\n') : []) {
    const [id = '', bits = ''] = line.split('\t');
    map.set(id, { count: bits.startsWith('1') ? 1 : 0, mentions: bits.endsWith('1') ? 1 : 0 });
  }
  return map;
}

/**
 * `SidebarModel.attention`. The list re-renders when *which* conversations
 * are unread changes, not on every message (a joined key of flags), and the
 * flags freeze while catching up, as each row's badge does.
 */
function useAttention(catchingUp: boolean, ready: boolean): (id: ConversationId) => boolean {
  const stores = useStores();
  const now = useNow(60_000);
  const local = useStore(stores.local, (s) => s.conversations);
  const live = useStore(stores.conversations, (s) => unreadFlags(s.unread));
  const shelf = useCatchUpShelf();
  const flags = useFrozenWhile(live, catchingUp, ready, { shelf, key: 'flags' });
  // Marked as read here during the hold: those chats are held at nothing unread at once (S1).
  const released = useStore(stores.session, (s) => s.heldReleased);
  const byId = useMemo(() => {
    const map = parseFlags(flags);
    for (const id of released) map.delete(id);
    return map;
  }, [flags, released]);
  return useCallback(
    (id) => {
      const state = local[id];
      return needsAttention(
        attentionOf(
          byId.get(id),
          isMuted(state?.muted ?? false, now),
          state?.markedUnread === true,
        ),
      );
    },
    [byId, local, now],
  );
}

/** Sections for the selected space, recomputed only when their inputs change. */
export function useSidebarModel(): SidebarModel {
  const stores = useStores();
  const space = useStore(stores.ui, uiSelectors.selectedSpace);
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const homeCollapsed = useStore(stores.spaces, (s) => s.homeCollapsed);
  const splitByType = useStore(stores.settings, (s) => s.appearance.splitHomeByType);
  const catchingUp = useStore(stores.session, sessionSelectors.catchingUp);
  const liveViews = useMemo(() => selectConversationViews(byId, local), [byId, local]);
  const views = useFrozenOrder(liveViews, catchingUp);
  const attention = useAttention(catchingUp, liveViews.length > 0);
  return useMemo(() => {
    const sections =
      space === HOME
        ? buildHomeSections(views, { spaces, homeCollapsed }, { splitByType })
        : buildSpaceSections(space, { spaces }, indexViews(views));
    return {
      space,
      sections,
      archived: archivedIds(views, space, { spaces }),
      selected,
      catchingUp,
      attention,
    };
  }, [views, spaces, homeCollapsed, splitByType, space, selected, catchingUp, attention]);
}

/**
 * The order the sidebar has on screen (frozen views and attention included),
 * published by the list while it is mounted so keyboard stepping walks the
 * same rows the user sees, not a fresh computation that can differ during
 * catch-up.
 */
let rendered: { space: SpaceSelection; order: readonly ConversationId[] } | null = null;

/** The list calls this with what it renders; the returned function withdraws it. */
export function useRenderedOrder(space: SpaceSelection, order: readonly ConversationId[]): void {
  const key = order.join('\n');
  useEffect(() => {
    const mine = { space, order: key ? (key.split('\n') as ConversationId[]) : [] };
    rendered = mine;
    return () => {
      if (rendered === mine) rendered = null;
    };
  }, [space, key]);
}

/** Non-React access for keyboard commands: the rendered order of the current sidebar. */
export function currentNavigationOrder(stores: Stores): ConversationId[] {
  const ui = stores.ui.getState();
  // What the list shows right now, when it is mounted (see `useRenderedOrder`).
  if (rendered && rendered.space === ui.selectedSpace) return [...rendered.order];
  const views = selectConversationViews(
    stores.conversations.getState().byId,
    stores.local.getState().conversations,
  );
  const sections = sectionsFor(
    ui.selectedSpace,
    views,
    stores.spaces.getState(),
    homeLayout(stores),
  );
  const unread = stores.conversations.getState().unread;
  const local = stores.local.getState().conversations;
  const now = Date.now();
  return navigationOrder(sections, uiSelectors.selectedConversation(ui), (id) => {
    const state = local[id];
    return needsAttention(
      attentionOf(unread[id], isMuted(state?.muted ?? false, now), state?.markedUnread === true),
    );
  });
}

/** Every conversation in Home and the spaces, in rail order. */
export function currentGlobalOrder(stores: Stores): Location[] {
  const views = selectConversationViews(
    stores.conversations.getState().byId,
    stores.local.getState().conversations,
  );
  const spaces = stores.spaces.getState();
  return globalOrder(
    buildHomeSections(views, spaces, homeLayout(stores)),
    spaces,
    indexViews(views),
  );
}
