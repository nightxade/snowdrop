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

/** What one conversation contributes to the badges (see `attentionOf`). */
export interface Attention extends UnreadState {
  /** Something unread that isn't muted: the unread dot. */
  hasUnread: boolean;
}

/**
 * The one rule for "does this conversation want attention", used by every
 * badge, dot and "next unread" stop. Mentions always count, muted or not. A
 * muted conversation adds no unread count and no dot. One the user marked
 * unread that has nothing unread counts as one (unless a mention already
 * says so).
 */
export function attentionOf(
  unread: UnreadState | undefined,
  muted: boolean,
  markedUnread: boolean,
): Attention {
  const mentions = unread?.mentions ?? 0;
  if (muted) return { count: 0, mentions, hasUnread: false };
  const count = unread?.count ?? 0;
  if (count > 0) return { count, mentions, hasUnread: true };
  if (markedUnread && mentions === 0) return { count: 1, mentions, hasUnread: true };
  return { count: 0, mentions, hasUnread: false };
}

/** Whether the conversation shows any indicator at all (a dot, a count or a mention). */
export function needsAttention(attention: Attention): boolean {
  return attention.hasUnread || attention.mentions > 0;
}

/**
 * Sum of unread across conversations; muted ones don't add to the count
 * (mentions always do). A conversation the user marked unread that has
 * nothing unread counts as one. Archived conversations count for nothing,
 * as in Signal Desktop's badge.
 */
export function totalUnread(
  unread: ConversationsState['unread'],
  local: LocalById,
  ids: readonly ConversationId[],
  now: number,
): Attention {
  let count = 0;
  let mentions = 0;
  let hasUnread = false;
  for (const id of ids) {
    const state = local[id] ?? DEFAULT_LOCAL_CONVERSATION;
    if (state.archived) continue;
    const one = attentionOf(unread[id], isMuted(state.muted, now), state.markedUnread === true);
    count += one.count;
    mentions += one.mentions;
    if (one.hasUnread) hasUnread = true;
  }
  return { count, mentions, hasUnread };
}

/**
 * The conversations among `ids` with something unread (or marked unread),
 * muted or not. Archived ones are included only when asked: Signal Desktop's
 * "mark all as read" for a chat folder clears them too, but offers the action
 * only when a chat that can be counted (not archived) is unread.
 */
export function unreadConversationIds(
  unread: ConversationsState['unread'],
  local: LocalById,
  ids: readonly ConversationId[],
  { includeArchived = false }: { includeArchived?: boolean } = {},
): ConversationId[] {
  return ids.filter((id) => {
    const state = local[id] ?? DEFAULT_LOCAL_CONVERSATION;
    if (state.archived && !includeArchived) return false;
    return (unread[id]?.count ?? 0) > 0 || state.markedUnread === true;
  });
}
