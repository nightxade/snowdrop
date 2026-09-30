import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, ConversationView } from '@/core/domain';
import {
  HOME,
  selectConversationViews,
  uiSelectors,
  type SpaceSelection,
  type SpacesData,
  type Stores,
} from '@/core/stores';
import { useStores } from '@/ui/hooks';
import {
  archivedIds,
  buildHomeSections,
  buildSpaceSections,
  globalOrder,
  navigationOrder,
  type Location,
  type SidebarSection,
} from './model';

export interface SidebarModel {
  space: SpaceSelection;
  sections: SidebarSection[];
  archived: ConversationId[];
  selected: ConversationId | null;
}

function indexViews(views: readonly ConversationView[]): Record<string, ConversationView> {
  const out: Record<string, ConversationView> = {};
  for (const v of views) out[v.id] = v;
  return out;
}

function sectionsFor(
  space: SpaceSelection,
  views: readonly ConversationView[],
  spaces: SpacesData,
): SidebarSection[] {
  return space === HOME
    ? buildHomeSections(views, spaces)
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
  return useMemo(() => {
    const views = selectConversationViews(byId, local);
    const sections =
      space === HOME
        ? buildHomeSections(views, { spaces, homeCollapsed })
        : buildSpaceSections(space, { spaces }, indexViews(views));
    return { space, sections, archived: space === HOME ? archivedIds(views) : [], selected };
  }, [byId, local, spaces, homeCollapsed, space, selected]);
}

/** Non-React access for keyboard commands: the rendered order of the current sidebar. */
export function currentNavigationOrder(stores: Stores): ConversationId[] {
  const ui = stores.ui.getState();
  const views = selectConversationViews(
    stores.conversations.getState().byId,
    stores.local.getState().conversations,
  );
  const sections = sectionsFor(ui.selectedSpace, views, stores.spaces.getState());
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
  return globalOrder(buildHomeSections(views, spaces), spaces, indexViews(views));
}
