import type { ConversationId, Message } from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { ConversationsStore } from '@/core/stores';

/**
 * Keeps a conversation's sidebar preview honest once a message has left the
 * repository (deleted for me, expired, purged). If it was the preview, the
 * newest message that remains takes over, or the preview is cleared; a
 * preview that has already moved on is untouched. Call after the delete.
 * (A delete-for-everyone keeps a tombstone and goes through `updateMessage`.)
 */
export async function refreshPreviewAfterRemoval(
  conversations: ConversationsStore,
  repository: Pick<MessageRepository, 'latest'>,
  conversationId: ConversationId,
  removed: Pick<Message, 'id'>,
): Promise<void> {
  if (conversations.getState().lastMessage[conversationId]?.id !== removed.id) return;
  const next = await repository.latest(conversationId);
  conversations.getState().replaceLatest(conversationId, removed.id, next);
}
