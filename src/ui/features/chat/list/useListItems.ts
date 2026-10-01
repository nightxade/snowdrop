import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, RenderItem } from '@/core/domain';
import {
  createRenderItemsSelector,
  messagesSelectors,
  sessionSelectors,
  uiSelectors,
} from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { createIndexTracker, type TrackedIndex } from '../lib/indexTracker';

export interface ListItems extends TrackedIndex {
  items: RenderItem[];
  loaded: boolean;
  loading: boolean;
  hasMoreBefore: boolean;
  anchoredToPresent: boolean;
}

/**
 * Render items for the open conversation plus the virtualiser bookkeeping.
 * Items only change when the window's id list or the unread marker change;
 * edits and reactions re-render single rows, never the list.
 */
export function useListItems(conversationId: ConversationId): ListItems {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const marker = useStore(stores.ui, uiSelectors.unreadMarker(conversationId));
  const select = useMemo(() => createRenderItemsSelector(conversationId), [conversationId]);
  const grouped = useStore(stores.messages, (s) => select(s, marker, selfId ?? undefined));
  const loaded = useStore(
    stores.messages,
    (s) => messagesSelectors.window(conversationId)(s).loaded,
  );
  const loading = useStore(
    stores.messages,
    (s) => messagesSelectors.window(conversationId)(s).loading,
  );
  const hasMoreBefore = useStore(
    stores.messages,
    (s) => messagesSelectors.window(conversationId)(s).hasMoreBefore,
  );
  const anchoredToPresent = useStore(
    stores.messages,
    (s) => messagesSelectors.window(conversationId)(s).anchoredToPresent,
  );
  // With older history still unloaded, the window's first message needn't be
  // the first of its day, so a leading day divider would be a guess — and it
  // would move to the new top on every prepend, changing a row the
  // virtualiser has already measured (a visible jump). Only show it once the
  // start of history (or the previous day) is loaded.
  const items = useMemo(
    () => (hasMoreBefore && grouped[0]?.type === 'day-divider' ? grouped.slice(1) : grouped),
    [grouped, hasMoreBefore],
  );
  // One tracker per mounted list (the pane remounts per conversation).
  const [track] = useState(createIndexTracker);
  const { firstItemIndex, epoch } = track(items);
  return { items, firstItemIndex, epoch, loaded, loading, hasMoreBefore, anchoredToPresent };
}
