import { describe, expect, it } from 'vitest';
import { conversationIdFor, makeConversation, makeMessage } from '@/core/domain/testing';
import {
  computeUnread,
  conversationsSelectors,
  createConversationsStore,
  totalUnread,
} from './conversations';

const conv = conversationIdFor('c');
const SELF = 'me';
const mention = (id: string) => [{ start: 0, length: 1, mentionId: id }];

describe('unread counting', () => {
  const msgs = [
    makeMessage({ conversationId: conv, authorId: 'a', sentAt: 1 }),
    makeMessage({ conversationId: conv, authorId: 'a', sentAt: 2, ranges: mention(SELF) }),
    makeMessage({ conversationId: conv, authorId: SELF, sentAt: 3 }),
    makeMessage({ conversationId: conv, authorId: 'b', sentAt: 4, kind: 'system' }),
    makeMessage({ conversationId: conv, authorId: 'b', sentAt: 5, deleted: true }),
    makeMessage({ conversationId: conv, authorId: 'b', sentAt: 6, ranges: mention('someone') }),
  ];

  it('counts only others’ real messages after the cursor', () => {
    expect(computeUnread(msgs, SELF, undefined)).toEqual({ count: 3, mentions: 1 });
    expect(computeUnread(msgs, SELF, 1)).toEqual({ count: 2, mentions: 1 });
    expect(computeUnread(msgs, SELF, 2)).toEqual({ count: 1, mentions: 0 });
    expect(computeUnread(msgs, SELF, 6)).toEqual({ count: 0, mentions: 0 });
  });

  it('increments incrementally and resets on markRead', () => {
    const store = createConversationsStore();
    store.getState().upsert(makeConversation({ id: conv }));
    store.getState().setReadCursors({ [conv]: 1 });
    for (const m of msgs) store.getState().applyIncoming(m, SELF);
    expect(store.getState().unread[conv]).toEqual({ count: 2, mentions: 1 });

    expect(store.getState().markRead(conv, 6)).toBe(true);
    expect(conversationsSelectors.unread(conv)(store.getState())).toEqual({
      count: 0,
      mentions: 0,
    });
    expect(store.getState().readCursors[conv]).toBe(6);
    // Idempotent, and cursors never move backwards.
    expect(store.getState().markRead(conv, 3)).toBe(false);
    expect(store.getState().readCursors[conv]).toBe(6);
    // Messages at/before the cursor (late arrivals) don't count.
    store
      .getState()
      .applyIncoming(makeMessage({ conversationId: conv, authorId: 'a', sentAt: 5 }), SELF);
    expect(store.getState().unread[conv]?.count).toBe(0);
  });

  it('sums totals, ignoring muted counts but keeping their mentions', () => {
    const store = createConversationsStore();
    const muted = conversationIdFor('m');
    store
      .getState()
      .upsertMany([
        makeConversation({ id: conv }),
        makeConversation({ id: muted, muted: { until: 2000 } }),
      ]);
    store.getState().setUnread(conv, { count: 2, mentions: 0 });
    store.getState().setUnread(muted, { count: 5, mentions: 1 });
    expect(totalUnread(store.getState(), [conv, muted], 1000)).toEqual({
      count: 2,
      mentions: 1,
      hasUnread: true,
    });
    // After the mute lapses, its count is included.
    expect(totalUnread(store.getState(), [conv, muted], 3000).count).toBe(7);
  });
});

describe('ordering', () => {
  it('orders by activity, is memoised, and never moves activity backwards', () => {
    const store = createConversationsStore();
    const a = conversationIdFor('a');
    const b = conversationIdFor('b');
    store
      .getState()
      .upsertMany([
        makeConversation({ id: a, title: 'A', lastActivityAt: 10 }),
        makeConversation({ id: b, title: 'B', lastActivityAt: 20 }),
        makeConversation({ id: conversationIdFor('z'), title: 'Z', archived: true }),
      ]);
    const first = conversationsSelectors.ordered(store.getState());
    expect(first.map((c) => c.title)).toEqual(['B', 'A']);
    expect(conversationsSelectors.ordered(store.getState())).toBe(first);
    store.getState().bumpActivity(a, 30);
    expect(conversationsSelectors.ordered(store.getState()).map((c) => c.title)).toEqual([
      'A',
      'B',
    ]);
    store.getState().bumpActivity(a, 5);
    expect(store.getState().byId[a]?.lastActivityAt).toBe(30);
  });
});
