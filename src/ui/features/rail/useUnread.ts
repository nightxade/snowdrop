import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ConversationId } from '@/core/domain';
import {
  selectConversationViews,
  sessionSelectors,
  totalUnread,
  type ConversationsState,
  type SpaceId,
} from '@/core/stores';
import { useCatchUpShelf, useFrozenWhile, useNow, useStores } from '@/ui/hooks';

export interface RailUnread {
  /** Show the unread dot: something unread that isn't muted. */
  hasUnread: boolean;
  /** Mentions always count, even when muted. */
  mentions: number;
}

type UnreadById = ConversationsState['unread'];

/**
 * What the rail counts as unread: the live counts, except while catching up, when they are held
 * as the sidebar holds them (S1), so a tile does not light for what the held list does not show.
 * Chats the user marked as read meanwhile are held at nothing unread at once (what arrives after
 * stays held). The tiles do not subscribe to the counts here (they re-render when their own
 * indicator changes).
 */
function useHeldUnread(): (live: UnreadById) => UnreadById {
  const stores = useStores();
  const catchingUp = useStore(stores.session, sessionSelectors.catchingUp);
  const released = useStore(stores.session, (s) => s.heldReleased);
  const shelf = useCatchUpShelf();
  // Once the first sync has counted what is unread (the list shows a skeleton until then).
  const ready = useStore(stores.session, sessionSelectors.ready);
  const { unread } = stores.conversations.getState();
  const held = useFrozenWhile(unread, catchingUp, ready, { shelf, key: 'rail-unread' });
  return (live) => {
    if (!catchingUp) return live;
    if (released.length === 0) return held;
    return Object.fromEntries(Object.entries(held).filter(([id]) => !released.includes(id)));
  };
}

/**
 * Aggregate unread for one or more spaces (a folder passes several). A muted
 * space contributes mentions only. The result is compared shallowly, so a
 * tile re-renders only when its indicator changes.
 */
export function useSpacesUnread(spaceIds: readonly SpaceId[]): RailUnread {
  const stores = useStores();
  const now = useNow(60_000);
  const local = useStore(stores.local, (s) => s.conversations);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const unreadOf = useHeldUnread();
  return useStore(
    stores.conversations,
    useShallow((s): RailUnread => {
      const unread = unreadOf(s.unread);
      let hasUnread = false;
      let mentions = 0;
      for (const id of spaceIds) {
        const space = spaces[id];
        if (!space) continue;
        const ids = space.categories.flatMap((c) => c.conversationIds);
        const total = totalUnread(unread, local, ids, now);
        mentions += total.mentions;
        if (!space.muted && total.hasUnread) hasUnread = true;
      }
      return { hasUnread, mentions };
    }),
  );
}

/** Home: DMs plus groups that aren't in any space (archived ones excluded). */
export function useHomeUnread(): RailUnread {
  const stores = useStores();
  const now = useNow(60_000);
  const local = useStore(stores.local, (s) => s.conversations);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const unreadOf = useHeldUnread();
  return useStore(
    stores.conversations,
    useShallow((s): RailUnread => {
      const assigned = new Set<string>();
      for (const space of Object.values(spaces))
        for (const c of space.categories) for (const id of c.conversationIds) assigned.add(id);
      const ids: ConversationId[] = selectConversationViews(s.byId, local)
        .filter((v) => !v.archived && (v.kind === 'direct' || !assigned.has(v.id)))
        .map((v) => v.id);
      const total = totalUnread(unreadOf(s.unread), local, ids, now);
      return { hasUnread: total.hasUnread, mentions: total.mentions };
    }),
  );
}
