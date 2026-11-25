import type { ConversationId } from '@/core/domain';
import type { MessagesState } from '@/core/stores';

/**
 * What decides a list built from a chat's stored messages (search results, the pinned list): which
 * messages the chat has loaded, whether each is deleted, its edit count and, for a list of pins,
 * whether it is pinned. A message that arrives, goes (deleted, expired), is edited or is (un)pinned
 * changes it; a receipt, a status or a reaction does not.
 */
export function chatSignature(
  s: MessagesState,
  conversationId: ConversationId,
  withPins = false,
): string {
  let signature = '';
  for (const m of Object.values(s.windows[conversationId]?.byId ?? {}))
    signature += `${m.id}:${m.deleted ? 1 : 0}:${m.edits ?? 0}${withPins ? `:${m.pinned ? 1 : 0}` : ''};`;
  return signature;
}
