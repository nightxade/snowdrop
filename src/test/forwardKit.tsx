/** Boots the demo and seeds a received message to forward (forward feature tests). */
import { act } from '@testing-library/react';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { bootSnowdrop } from '@/test/renderWithSnowdrop';

export interface ForwardKit {
  snowdrop: Snowdrop;
  mock: MockBackend;
  /** The conversation the message is in (a group). */
  conversationId: ConversationId;
  authorId: string;
  message: Message;
  /** The id of a demo conversation (see MockWorld). */
  chat: (key: string) => ConversationId;
}

let seq = 0;

/** A received message in a demo group's window, as if someone had just written it. */
export async function bootForward(patch: Partial<Message> = {}): Promise<ForwardKit> {
  const snowdrop = await bootSnowdrop();
  const mock = (await snowdrop.backendReady) as MockBackend;
  const chat = (key: string): ConversationId => mock.world.conversationIds.get(key)!;
  const conversationId = chat('crux');
  const selfId = snowdrop.stores.session.getState().self!.id;
  const authorId = snowdrop.stores.conversations
    .getState()
    .byId[conversationId]!.memberIds.find((id) => id !== selfId)!;
  await act(async () => {
    await snowdrop.history.open(conversationId);
  });
  const sentAt = 1_700_000_000_000 + ++seq;
  const message: Message = {
    id: messageId(authorId, sentAt),
    conversationId,
    authorId,
    sentAt,
    receivedAt: sentAt,
    seq: 1_000_000 + seq,
    body: 'worth keeping',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'normal',
    ...patch,
  };
  act(() => {
    snowdrop.stores.messages.getState().appendLive(message);
  });
  return { snowdrop, mock, conversationId, authorId, message, chat };
}

/** Opens a conversation's window, so what is sent into it shows up in the store. */
export async function openChat(snowdrop: Snowdrop, id: ConversationId): Promise<void> {
  await act(async () => {
    await snowdrop.history.open(id);
  });
}

/** The messages of the user's own in a conversation, oldest first. */
export function ownMessages(snowdrop: Snowdrop, id: ConversationId): Message[] {
  const selfId = snowdrop.stores.session.getState().self!.id;
  const window = snowdrop.stores.messages.getState().windows[id];
  return (window?.ids ?? []).flatMap((mid) => {
    const m = window?.byId[mid];
    return m && m.authorId === selfId ? [m] : [];
  });
}
