import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, ConversationView } from '@/core/domain';
import {
  HOME,
  selectConversationViews,
  sessionSelectors,
  uiSelectors,
  type SpaceSelection,
  type SpacesData,
  type Stores,
} from '@/core/stores';
import { useFrozenWhile, useStores } from '@/ui/hooks';
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
 * While catching up, every conversation seen before it started keeps its
 * frozen view (so its position and whatever `buildHomeSections`/
 * `buildSpaceSections` derive from it — pinned/archived/kind, recency order
 * — hold still); a conversation that didn't exist yet is new activity and
 * still surfaces, ahead of the frozen ones.
 */
function useFrozenOrder(
  live: readonly ConversationView[],
  catchingUp: boolean,
): readonly ConversationView[] {
  const frozen = useFrozenWhile(live, catchingUp);
  if (!catchingUp) return live;
  const liveIds = new Set(live.map((v) => v.id));
  const frozenIds = new Set(frozen.map((v) => v.id));
  const fresh = live.filter((v) => !frozenIds.has(v.id));
  const stillPresent = frozen.filter((v) => liveIds.has(v.id));
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
    };
  }, [views, spaces, homeCollapsed, splitByType, space, selected, catchingUp]);
}

/** Non-React access for keyboard commands: the rendered order of the current sidebar. */
export function currentNavigationOrder(stores: Stores): ConversationId[] {
  const ui = stores.ui.getState();
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
  return navigationOrder(
    sections,
    uiSelectors.selectedConversation(ui),
    stores.conversations.getState().unread,
  );
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
