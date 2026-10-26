import { describe, expect, it } from 'vitest';
import { directConversationId, messageId, type Message } from '@/core/domain';
import { createStores } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { permissionsFor } from './actions';

const STRANGER = 'stranger-aci';
const id = directConversationId(STRANGER);

function setup() {
  const stores = createStores();
  stores.session.getState().setSelf({ id: 'me', name: 'Me', color: '#000', isSelf: true });
  stores.contacts.getState().upsert({ id: STRANGER, name: 'Marlowe', color: '#111' });
  stores.conversations.getState().upsert({
    id,
    kind: 'direct',
    title: 'Marlowe',
    memberIds: ['me', STRANGER],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: 1,
  });
  const app = {
    stores,
    send: { capabilities: { adminDelete: false, pin: true, polls: true } },
  } as unknown as AppServices;
  const message: Message = {
    id: messageId(STRANGER, 1),
    conversationId: id,
    authorId: STRANGER,
    sentAt: 1,
    receivedAt: 1,
    body: 'hi',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  };
  return { app, stores, message };
}

describe('message actions in a message request', () => {
  it('cannot reply, react or pin until the conversation is accepted', () => {
    const { app, stores, message } = setup();
    expect(permissionsFor(app, message)).toMatchObject({ canReact: false, canPin: false });
    stores.local.getState().markAccepted(id, 1);
    expect(permissionsFor(app, message)).toMatchObject({ canReact: true, canPin: true });
  });

  it('cannot while blocked either', () => {
    const { app, stores, message } = setup();
    stores.local.getState().markAccepted(id, 1);
    stores.contacts
      .getState()
      .upsert({ id: STRANGER, name: 'Marlowe', color: '#111', blocked: true });
    expect(permissionsFor(app, message).canReact).toBe(false);
  });

  it('cannot vote in a poll until the conversation is accepted, and never ends one that is not its own', () => {
    const { app, stores, message } = setup();
    const poll: Message = {
      ...message,
      poll: { question: 'Q?', options: ['a', 'b'], allowMultiple: false, votes: [] },
    };
    expect(permissionsFor(app, poll)).toMatchObject({ canVotePoll: false, canEndPoll: false });
    stores.local.getState().markAccepted(id, 1);
    expect(permissionsFor(app, poll)).toMatchObject({ canVotePoll: true, canEndPoll: false });
    // Not once it has ended, nor before it is sent.
    const ended = { ...poll, poll: { ...poll.poll!, ended: true } };
    expect(permissionsFor(app, ended).canVotePoll).toBe(false);
    expect(permissionsFor(app, { ...poll, id: 'pending:x' as Message['id'] }).canVotePoll).toBe(
      false,
    );
  });

  it('lets the author end an open, sent poll, even before the chat is accepted', () => {
    const { app, message } = setup();
    const mine: Message = {
      ...message,
      authorId: 'me',
      id: messageId('me', 2),
      poll: { question: 'Q?', options: ['a', 'b'], allowMultiple: false, votes: [] },
    };
    expect(permissionsFor(app, mine)).toMatchObject({ canEndPoll: true });
    expect(permissionsFor(app, { ...mine, status: 'failed' }).canEndPoll).toBe(false);
    expect(
      permissionsFor(
        { ...app, send: { capabilities: { polls: false } } } as unknown as AppServices,
        mine,
      ),
    ).toMatchObject({ canEndPoll: false, canVotePoll: false });
  });
});
