import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ConversationId } from '@/core/domain';
import { selectConversationViews, totalUnread, type SpaceId } from '@/core/stores';
import { useNow, useStores } from '@/ui/hooks';

export interface RailUnread {
  /** Show the unread dot: something unread that isn't muted. */
  hasUnread: boolean;
  /** Mentions always count, even when muted. */
  mentions: number;
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
  return useStore(
    stores.conversations,
    useShallow((s): RailUnread => {
      let hasUnread = false;
      let mentions = 0;
      for (const id of spaceIds) {
        const space = spaces[id];
        if (!space) continue;
        const ids = space.categories.flatMap((c) => c.conversationIds);
        const total = totalUnread(s.unread, local, ids, now);
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
  return useStore(
    stores.conversations,
    useShallow((s): RailUnread => {
      const assigned = new Set<string>();
      for (const space of Object.values(spaces))
        for (const c of space.categories) for (const id of c.conversationIds) assigned.add(id);
      const ids: ConversationId[] = selectConversationViews(s.byId, local)
        .filter((v) => !v.archived && (v.kind === 'direct' || !assigned.has(v.id)))
        .map((v) => v.id);
      const total = totalUnread(s.unread, local, ids, now);
      return { hasUnread: total.hasUnread, mentions: total.mentions };
    }),
  );
}
