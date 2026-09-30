/**
 * View models that combine several stores. Memoised on the identities of
 * their inputs so they're safe to use as React selectors without churn.
 */
import type { ConversationId, ConversationView } from '@/core/domain';
import { isMuted, type ConversationsState, type UnreadState } from './conversations';
import { DEFAULT_LOCAL_CONVERSATION, type LocalState } from './local';

type ById = ConversationsState['byId'];
type LocalById = LocalState['conversations'];

const viewsCache = new WeakMap<ById, WeakMap<LocalById, ConversationView[]>>();

/** Every conversation with its local state, most recent activity first (archived included). */
export function selectConversationViews(byId: ById, local: LocalById): ConversationView[] {
  let inner = viewsCache.get(byId);
  if (!inner) {
    inner = new WeakMap();
    viewsCache.set(byId, inner);
  }
  let views = inner.get(local);
  if (!views) {
    views = Object.values(byId)
      .map((c) => ({ ...c, ...(local[c.id] ?? DEFAULT_LOCAL_CONVERSATION) }))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title));
    inner.set(local, views);
  }
  return views;
}

export function selectConversationView(
  byId: ById,
  local: LocalById,
  id: ConversationId,
): ConversationView | undefined {
  const conversation = byId[id];
  return conversation
    ? { ...conversation, ...(local[id] ?? DEFAULT_LOCAL_CONVERSATION) }
    : undefined;
}

/** Sum of unread across conversations; muted ones don't add to the count (mentions always do). */
export function totalUnread(
  unread: ConversationsState['unread'],
  local: LocalById,
  ids: readonly ConversationId[],
  now: number,
): UnreadState & { hasUnread: boolean } {
  let count = 0;
  let mentions = 0;
  let hasUnread = false;
  for (const id of ids) {
    const u = unread[id];
    if (!u) continue;
    mentions += u.mentions;
    if (!isMuted((local[id] ?? DEFAULT_LOCAL_CONVERSATION).muted, now)) {
      count += u.count;
      if (u.count > 0) hasUnread = true;
    }
  }
  return { count, mentions, hasUnread };
}
