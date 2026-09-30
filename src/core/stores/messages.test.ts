import { describe, expect, it } from 'vitest';
import { messageId, pendingMessageId } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { createMessagesStore, messagesSelectors } from './messages';

const conv = conversationIdFor('c');
const m = (authorId: string, sentAt: number, extra = {}) =>
  makeMessage({ conversationId: conv, authorId, sentAt, ...extra });

describe('messagesStore', () => {
  it('keeps messages ordered across pages and live inserts', () => {
    const store = createMessagesStore();
    // A live message arrives before the initial page loads.
    store.getState().upsert(m('a', 50));
    expect(store.getState().windows[conv]?.loaded).toBe(false);
    store.getState().setInitialPage(conv, [m('a', 30), m('b', 40)], true);
    store.getState().prependPage(conv, [m('a', 10), m('b', 20)], false);
    store.getState().upsert(m('b', 35));
    const list = messagesSelectors.list(conv)(store.getState());
    expect(list.map((x) => x.sentAt)).toEqual([10, 20, 30, 35, 40, 50]);
    expect(store.getState().windows[conv]).toMatchObject({ loaded: true, hasMoreBefore: false });
    // Memoised on window identity.
    expect(messagesSelectors.list(conv)(store.getState())).toBe(list);
  });

  it('upserts replace in place without duplicating', () => {
    const store = createMessagesStore();
    store.getState().setInitialPage(conv, [m('a', 1, { body: 'one' })], false);
    store.getState().upsert(m('a', 1, { body: 'uno' }));
    const list = messagesSelectors.list(conv)(store.getState());
    expect(list).toHaveLength(1);
    expect(list[0]?.body).toBe('uno');
  });

  it('updates and removes', () => {
    const store = createMessagesStore();
    store.getState().setInitialPage(conv, [m('a', 1), m('a', 2)], false);
    store.getState().update(conv, messageId('a', 1), (x) => ({ ...x, body: 'edited' }));
    store.getState().remove(conv, messageId('a', 2));
    expect(
      messagesSelectors
        .list(conv)(store.getState())
        .map((x) => x.body),
    ).toEqual(['edited']);
    // Unknown ids are no-ops.
    const before = store.getState().windows;
    store.getState().update(conv, messageId('zz', 9), (x) => x);
    expect(store.getState().windows).toBe(before);
  });

  it('reconciles optimistic messages, keeping the nonce as a stable key', () => {
    const store = createMessagesStore();
    store.getState().setInitialPage(conv, [m('a', 1)], false);
    const pending = m('me', 100, { id: pendingMessageId('n1'), nonce: 'n1', status: 'pending' });
    store.getState().upsert(pending);
    expect(store.getState().findByNonce(conv, 'n1')?.id).toBe(pending.id);

    const final = m('me', 105, { status: 'sent' });
    store.getState().reconcile(conv, 'n1', final);
    const list = messagesSelectors.list(conv)(store.getState());
    expect(list.map((x) => x.id)).toEqual([messageId('a', 1), messageId('me', 105)]);
    expect(list[1]).toMatchObject({ status: 'sent', nonce: 'n1' });
  });

  it('merges when the acknowledged message already arrived via sync', () => {
    const store = createMessagesStore();
    store
      .getState()
      .upsert(m('me', 100, { id: pendingMessageId('n1'), nonce: 'n1', status: 'pending' }));
    store
      .getState()
      .upsert(
        m('me', 105, { status: 'delivered', reactions: [{ emoji: '👍', authorId: 'a', at: 1 }] }),
      );
    store.getState().reconcile(conv, 'n1', m('me', 105, { status: 'sent', reactions: [] }));
    const list = messagesSelectors.list(conv)(store.getState());
    expect(list).toHaveLength(1);
    expect(list[0]?.nonce).toBe('n1');
  });

  it('finds the last own message for edit-last', () => {
    const store = createMessagesStore();
    store
      .getState()
      .setInitialPage(
        conv,
        [
          m('me', 1, { body: 'mine' }),
          m('me', 2, { deleted: true }),
          m('a', 3),
          m('me', 4, { status: 'failed' }),
        ],
        false,
      );
    expect(messagesSelectors.lastOwn(conv, 'me')(store.getState())?.body).toBe('mine');
  });
});
