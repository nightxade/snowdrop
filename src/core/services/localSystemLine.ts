/**
 * A system line the user's own action wrote into a chat ("You ended the
 * poll", "You marked your Safety Number … as verified"): stored, shown, made
 * the chat's latest message, and read, like a message the user sends. It is
 * local only and never moves a chat up the list or lists one.
 */
import { mergeDuplicate, systemMessageId, type ConversationId, type Message } from '@/core/domain';
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
  line: { conversationId: ConversationId; authorId: string; text: string; tag: string },
): Promise<void> {
  const { repository, stores, clock } = deps;
  const now = clock.now();
  const draft: Message = {
    id: systemMessageId(line.authorId, now, line.tag),
    conversationId: line.conversationId,
    authorId: line.authorId,
    sentAt: now,
    receivedAt: now,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'system',
    systemText: line.text,
  };
  const { message } = await repository.upsert(draft, mergeDuplicate);
  stores.messages.getState().appendLive(message);
  stores.conversations.getState().noteLatest(message);
  // Our own action: the chat is read up to it, like a message we send.
  if (
    message.seq !== undefined &&
    stores.conversations.getState().markRead(line.conversationId, message.seq)
  )
    await repository.setReadCursor(line.conversationId, message.seq);
}
