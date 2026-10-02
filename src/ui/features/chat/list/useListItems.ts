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
import { advanceTrack, initialTrack, type TrackedIndex } from '../lib/indexTracker';

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
  const items = hasMoreBefore && grouped[0]?.type === 'day-divider' ? grouped.slice(1) : grouped;
  // Derived state (React's "adjust state while rendering" pattern): the
  // index must change in the same render as the data, or the virtualiser
  // would see one frame of new rows at old indices and jump.
  const [derived, setDerived] = useState(() => ({
    source: [] as readonly RenderItem[],
    sourceHasMore: true,
    items: [] as RenderItem[],
    track: initialTrack(),
  }));
  let current = derived;
  if (derived.source !== grouped || derived.sourceHasMore !== hasMoreBefore) {
    const stable = keepGroupStarts(derived.items, items);
    current = {
      source: grouped,
      sourceHasMore: hasMoreBefore,
      items: stable,
      track: advanceTrack(derived.track, stable),
    };
    setDerived(current);
  }
  const { firstItemIndex, epoch } = current.track;
  return {
    items: current.items,
    firstItemIndex,
    epoch,
    loaded,
    loading,
    hasMoreBefore,
    anchoredToPresent,
  };
}

/**
 * A row that was rendered as the start of an author group keeps its header
 * when older history is prepended, even if the message before it turns out
 * to be by the same author. Collapsing it would shrink a row the virtualiser
 * has already measured, above the reader's position — a visible jump.
 */
function keepGroupStarts(previous: readonly RenderItem[], next: RenderItem[]): RenderItem[] {
  const starts = new Set<string>();
  for (const it of previous) if (it.type === 'message' && !it.continuation) starts.add(it.key);
  if (starts.size === 0) return next;
  const keep = (it: RenderItem) => it.type === 'message' && it.continuation && starts.has(it.key);
  if (!next.some(keep)) return next;
  return next.map((it) =>
    it.type === 'message' && keep(it) ? { ...it, continuation: false } : it,
  );
}
