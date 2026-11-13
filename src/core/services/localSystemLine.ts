/**
 * A system line the user's own action wrote into a chat ("You ended the
 * poll", "You marked your Safety Number … as verified"): stored, shown, made
 * the chat's latest message, and read, like a message the user sends. It is
 * local only and never moves a chat up the list or lists one.
 */
import {
  mergeDuplicate,
  systemMessageId,
  type ConversationId,
  type Message,
  type SystemAction,
} from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';

export interface LocalSystemLineDeps {
  repository: MessageRepository;
  stores: Stores;
  clock: { now(): number };
}

/**
 * Writes the line and marks the chat read up to it. `tag` keeps ids of
 * different kinds of line apart (see `systemMessageId`). Rejects when the
 * repository does; each caller decides how a failure is reported.
 */
export async function appendLocalSystemLine(
  deps: LocalSystemLineDeps,
  line: {
    conversationId: ConversationId;
    authorId: string;
    text: string;
    tag: string;
    action?: SystemAction;
    /** Leave the chat's unread messages unread (an answer given from outside the open chat). */
    keepUnread?: true;
    /** Never the sidebar preview (see `Message.previewless`). */
    previewless?: true;
    /**
     * When it happened, when that is not now (an answer given on another
     * device): the line's id comes from it, so a replay of the same sync
     * writes the same line, not a second one.
     */
    at?: number;
  },
): Promise<void> {
  const { repository, stores, clock } = deps;
  const now = clock.now();
  const draft: Message = {
    id: systemMessageId(line.authorId, line.at ?? now, line.tag),
    conversationId: line.conversationId,
    authorId: line.authorId,
    sentAt: line.at ?? now,
    receivedAt: now,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'system',
    systemText: line.text,
    ...(line.action ? { systemAction: line.action } : {}),
    ...(line.previewless ? { previewless: true as const } : {}),
  };
  const { message } = await repository.upsert(draft, mergeDuplicate);
  stores.messages.getState().appendLive(message);
  stores.conversations.getState().noteLatest(message);
  // Our own action: the chat is read up to it, like a message we send.
  if (
    !line.keepUnread &&
    message.seq !== undefined &&
    stores.conversations.getState().markRead(line.conversationId, message.seq)
  )
    await repository.setReadCursor(line.conversationId, message.seq);
}
