import { describe, expect, it } from 'vitest';
import { messageId, pendingMessageId } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { createMessagesStore, createRenderItemsSelector, messagesSelectors } from './messages';

const conv = conversationIdFor('c');
const m = (authorId: string, seq: number, extra = {}) =>
  makeMessage({ conversationId: conv, authorId, sentAt: seq * 1000, seq, ...extra });
const seqs = (store: ReturnType<typeof createMessagesStore>) =>
  messagesSelectors
    .list(conv)(store.getState())
    .map((x) => x.seq);

describe('messagesStore windows', () => {
  it('orders by seq across pages and live appends', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(conv, [m('a', 30), m('b', 40)], { hasMoreBefore: true, hasMoreAfter: false });
    store.getState().prependPage(conv, [m('a', 10), m('b', 20)], false);
    expect(store.getState().appendLive(m('b', 50))).toBe(true);
    expect(seqs(store)).toEqual([10, 20, 30, 40, 50]);
    expect(store.getState().windows[conv]).toMatchObject({
      loaded: true,
      hasMoreBefore: false,
      anchoredToPresent: true,
    });
  });

  it('only appends live messages to loaded windows anchored to the present', () => {
    const store = createMessagesStore();
    expect(store.getState().appendLive(m('a', 1))).toBe(false);
    expect(store.getState().windows[conv]).toBeUndefined();

    store.getState().replaceWindow(conv, [m('a', 5)], { hasMoreBefore: true, hasMoreAfter: true });
    expect(store.getState().windows[conv]?.anchoredToPresent).toBe(false);
    expect(store.getState().appendLive(m('a', 99))).toBe(false);
    // …but updates to a message that *is* loaded still apply.
    expect(store.getState().appendLive(m('a', 5, { body: 'edited' }))).toBe(true);
    expect(messagesSelectors.list(conv)(store.getState())[0]?.body).toBe('edited');
  });

  it('keeps the ids array identity for in-place updates (cheap re-renders)', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(conv, [m('a', 1), m('a', 2)], { hasMoreBefore: false, hasMoreAfter: false });
    const ids = messagesSelectors.ids(conv)(store.getState());
    store.getState().update(conv, messageId('a', 1000), (x) => ({
      ...x,
      reactions: [{ emoji: '👍', authorId: 'b', at: 1 }],
    }));
    store.getState().appendLive(m('a', 2, { status: 'delivered' }));
    expect(messagesSelectors.ids(conv)(store.getState())).toBe(ids);
    store.getState().appendLive(m('a', 3));
    expect(messagesSelectors.ids(conv)(store.getState())).not.toBe(ids);
  });

  it('evicts the far side beyond the cap', () => {
    const store = createMessagesStore(4);
    store.getState().replaceWindow(conv, [m('a', 5), m('a', 6), m('a', 7)], {
      hasMoreBefore: true,
      hasMoreAfter: false,
    });
    store.getState().prependPage(conv, [m('a', 3), m('a', 4)], true);
    // Scrolling back drops the newest: the window detaches from the present.
    expect(seqs(store)).toEqual([3, 4, 5, 6]);
    expect(store.getState().windows[conv]).toMatchObject({
      hasMoreAfter: true,
      anchoredToPresent: false,
    });
    store.getState().appendPage(conv, [m('a', 7), m('a', 8)], false);
    expect(seqs(store)).toEqual([5, 6, 7, 8]);
    expect(store.getState().windows[conv]).toMatchObject({
      hasMoreBefore: true,
      anchoredToPresent: true,
    });
    // Live appends beyond the cap drop the oldest.
    store.getState().appendLive(m('a', 9));
    expect(seqs(store)).toEqual([6, 7, 8, 9]);
  });

  it('updates and removes', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(conv, [m('a', 1), m('a', 2)], { hasMoreBefore: false, hasMoreAfter: false });
    store.getState().update(conv, messageId('a', 1000), (x) => ({ ...x, body: 'edited' }));
    store.getState().remove(conv, messageId('a', 2000));
    expect(
      messagesSelectors
        .list(conv)(store.getState())
        .map((x) => x.body),
    ).toEqual(['edited']);
    const before = store.getState().windows;
    store.getState().update(conv, messageId('zz', 9), (x) => x);
    expect(store.getState().windows).toBe(before);
  });

  it('reconciles optimistic messages in place, keeping the nonce as a stable key', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(conv, [m('a', 1)], { hasMoreBefore: false, hasMoreAfter: false });
    const pending = m('me', 2, { id: pendingMessageId('n1'), nonce: 'n1', status: 'pending' });
    store.getState().appendLive(pending);
    store.getState().appendLive(m('b', 3));
    expect(store.getState().findByNonce(conv, 'n1')?.id).toBe(pending.id);

    store
      .getState()
      .reconcile(
        conv,
        'n1',
        m('me', 2, { sentAt: 2500, id: messageId('me', 2500), status: 'sent' }),
      );
    const list = messagesSelectors.list(conv)(store.getState());
    // Same timeline position (seq), new identity.
    expect(list.map((x) => x.id)).toEqual([
      messageId('a', 1000),
      messageId('me', 2500),
      messageId('b', 3000),
    ]);
    expect(list[1]).toMatchObject({ status: 'sent', nonce: 'n1' });
  });

  it('merges when the acknowledged message already arrived via sync', () => {
    const store = createMessagesStore();
    store.getState().replaceWindow(conv, [], { hasMoreBefore: false, hasMoreAfter: false });
    store
      .getState()
      .appendLive(m('me', 1, { id: pendingMessageId('n1'), nonce: 'n1', status: 'pending' }));
    store.getState().appendLive(m('me', 2, { id: messageId('me', 105), status: 'delivered' }));
    store
      .getState()
      .reconcile(conv, 'n1', m('me', 2, { id: messageId('me', 105), status: 'delivered' }));
    const list = messagesSelectors.list(conv)(store.getState());
    expect(list).toHaveLength(1);
    expect(list[0]?.nonce).toBe('n1');
  });

  it('never offers a pending or failed message for edit-last', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(
        conv,
        [
          m('me', 1, { body: 'mine' }),
          m('me', 2, { deleted: true }),
          m('a', 3),
          m('me', 4, { status: 'failed' }),
          m('me', 5, { id: pendingMessageId('n'), nonce: 'n', status: 'pending' }),
        ],
        { hasMoreBefore: false, hasMoreAfter: false },
      );
    expect(messagesSelectors.lastOwn(conv, 'me')(store.getState())?.body).toBe('mine');
  });
});

describe('createRenderItemsSelector', () => {
  it('recomputes only when layout inputs change', () => {
    const store = createMessagesStore();
    store
      .getState()
      .replaceWindow(conv, [m('a', 1), m('a', 2)], { hasMoreBefore: false, hasMoreAfter: false });
    const select = createRenderItemsSelector(conv);
    const first = select(store.getState(), undefined, 'me');
    expect(first.map((i) => i.type)).toEqual(['day-divider', 'message', 'message']);
    store.getState().update(conv, messageId('a', 1000), (x) => ({ ...x, body: 'edited' }));
    expect(select(store.getState(), undefined, 'me')).toBe(first);
    expect(select(store.getState(), 1, 'me')).not.toBe(first);
  });
});
