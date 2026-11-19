/**
 * The chat the user has open stays open when it is moved to another space or taken out of its
 * space (the pane keeps showing it, where the user is), and the space it now lives in (Home for a
 * chat that is out of every space) shows it as its open chat, so going there finds it selected
 * instead of "Pick a conversation".
 */
import { HOME, spacesSelectors, uiSelectors, type SpacesState, type Stores } from '@/core/stores';
import type { Unsubscribe } from '@/core/lib';

export function openChatFollowsSpace(stores: Stores): Unsubscribe {
  return stores.spaces.subscribe((next: SpacesState, prev: SpacesState) => {
    if (next.spaces === prev.spaces) return;
    const ui = stores.ui.getState();
    const open = uiSelectors.selectedConversation(ui);
    if (open === null) return;
    // A direct chat is always in Home, whatever space it is also filed in.
    const kind = stores.conversations.getState().byId[open]?.kind;
    if (kind !== 'group') return;
    const was = spacesSelectors.spaceOf(open)(prev) ?? HOME;
    const now = spacesSelectors.spaceOf(open)(next) ?? HOME;
    if (was === now || now === ui.selectedSpace) return;
    ui.rememberConversation(open, now);
  });
}
