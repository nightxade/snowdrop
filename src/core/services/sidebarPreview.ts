import type { ConversationId, Message } from '@/core/domain';
import { latestPreviewMessage, type MessageRepository } from '@/core/persistence';
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
  repository: Pick<MessageRepository, 'latest' | 'page'>,
  conversationId: ConversationId,
  removed: Pick<Message, 'id'>,
): Promise<void> {
  if (conversations.getState().lastMessage[conversationId]?.id !== removed.id) return;
  const next = await latestPreviewMessage(repository, conversationId);
  conversations.getState().replaceLatest(conversationId, removed.id, next);
}

/**
 * A send just settled under its real seq, which can differ from the one a
 * sync echo of it was stored under (the echo may have taken a later seq
 * than a reply that arrived meanwhile). If the message now previewed is
 * that one but the stored newest is another, the newest takes over; a
 * preview that has already moved on is untouched.
 */
export async function settlePreviewAfterSend(
  conversations: ConversationsStore,
  repository: Pick<MessageRepository, 'latest' | 'page'>,
  sent: Pick<Message, 'id' | 'conversationId'>,
): Promise<void> {
  if (conversations.getState().lastMessage[sent.conversationId]?.id !== sent.id) return;
  const newest = await latestPreviewMessage(repository, sent.conversationId);
  if (newest && newest.id !== sent.id)
    conversations.getState().replaceLatest(sent.conversationId, sent.id, newest);
}

/**
 * Applies a change to a message (an edit, a delete for everyone, a revert of
 * either) to the sidebar preview too, if that message is the one previewed;
 * a preview that has already moved on is untouched. An edited message keeps
 * its id and seq, so the store accepts it as the same preview.
 */
export function followPreview(
  conversations: ConversationsStore,
  conversationId: ConversationId,
  id: Message['id'],
  change: (message: Message) => Message,
): void {
  const state = conversations.getState();
  const latest = state.lastMessage[conversationId];
  if (latest?.id === id) state.noteLatest(change(latest));
}
