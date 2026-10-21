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
    send: { capabilities: { adminDelete: false, pin: true } },
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
});
