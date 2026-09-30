import { describe, expect, it } from 'vitest';
import { conversationIdFor, makeConversation, makeMessage } from '@/core/domain/testing';
import { computeUnread, conversationsSelectors, createConversationsStore } from './conversations';
import { createLocalStore } from './local';
import { selectConversationViews, totalUnread } from './views';

const conv = conversationIdFor('c');
const SELF = 'me';
const mention = (id: string) => [{ start: 0, length: 1, mentionId: id }];

describe('unread counting (by arrival seq)', () => {
  const msgs = [
    makeMessage({ conversationId: conv, authorId: 'a', sentAt: 1, seq: 1 }),
    makeMessage({ conversationId: conv, authorId: 'a', sentAt: 2, seq: 2, ranges: mention(SELF) }),
    makeMessage({ conversationId: conv, authorId: SELF, sentAt: 3, seq: 3 }),
    makeMessage({ conversationId: conv, authorId: 'b', sentAt: 4, seq: 4, kind: 'system' }),
    makeMessage({ conversationId: conv, authorId: 'b', sentAt: 5, seq: 5, deleted: true }),
    makeMessage({
      conversationId: conv,
      authorId: 'b',
      sentAt: 6,
      seq: 6,
      ranges: mention('someone'),
    }),
  ];

  it('counts only others’ real messages after the cursor', () => {
    expect(computeUnread(msgs, SELF, undefined)).toEqual({ count: 3, mentions: 1 });
    expect(computeUnread(msgs, SELF, 1)).toEqual({ count: 2, mentions: 1 });
    expect(computeUnread(msgs, SELF, 2)).toEqual({ count: 1, mentions: 0 });
    expect(computeUnread(msgs, SELF, 6)).toEqual({ count: 0, mentions: 0 });
  });

  it('counts a message from a sender with a skewed clock', () => {
    const skewed = makeMessage({ conversationId: conv, authorId: 'a', sentAt: 0, seq: 10 });
    expect(computeUnread([skewed], SELF, 6)).toEqual({ count: 1, mentions: 0 });
  });

  it('increments, decrements on removal and resets on markRead', () => {
    const store = createConversationsStore();
    store.getState().upsert(makeConversation({ id: conv }));
    store.getState().setReadCursors({ [conv]: 1 });
    for (const m of msgs) store.getState().applyIncoming(m, SELF);
    expect(store.getState().unread[conv]).toEqual({ count: 2, mentions: 1 });
    store.getState().applyRemoval(msgs[1]!, SELF);
    expect(store.getState().unread[conv]).toEqual({ count: 1, mentions: 0 });

    expect(store.getState().markRead(conv, 6)).toBe(true);
    expect(conversationsSelectors.unread(conv)(store.getState())).toEqual({
      count: 0,
      mentions: 0,
    });
    expect(store.getState().readCursors[conv]).toBe(6);
    // Idempotent, and cursors never move backwards.
    expect(store.getState().markRead(conv, 3)).toBe(false);
    expect(store.getState().readCursors[conv]).toBe(6);
  });
});

describe('protocol vs local state', () => {
  it('keeps the newest activity when the backend re-sends a conversation', () => {
    const store = createConversationsStore();
    store.getState().upsert(makeConversation({ id: conv, lastActivityAt: 50 }));
    store.getState().upsert(makeConversation({ id: conv, title: 'Renamed', lastActivityAt: 10 }));
    expect(store.getState().byId[conv]).toMatchObject({ title: 'Renamed', lastActivityAt: 50 });
    store.getState().bumpActivity(conv, 5);
    expect(store.getState().byId[conv]?.lastActivityAt).toBe(50);
  });

  it('combines into memoised views; backend updates cannot touch local state', () => {
    const conversations = createConversationsStore();
    const local = createLocalStore();
    const a = conversationIdFor('a');
    const b = conversationIdFor('b');
    conversations
      .getState()
      .upsertMany([
        makeConversation({ id: a, title: 'A', lastActivityAt: 10 }),
        makeConversation({ id: b, title: 'B', lastActivityAt: 20 }),
      ]);
    local.getState().setPinned(a, true);
    local.getState().setDraft(a, 'wip');
    const views = selectConversationViews(
      conversations.getState().byId,
      local.getState().conversations,
    );
    expect(views.map((v) => [v.title, v.pinned, v.draft])).toEqual([
      ['B', false, undefined],
      ['A', true, 'wip'],
    ]);
    expect(
      selectConversationViews(conversations.getState().byId, local.getState().conversations),
    ).toBe(views);

    conversations.getState().upsert(makeConversation({ id: a, title: 'A2', lastActivityAt: 10 }));
    const after = selectConversationViews(
      conversations.getState().byId,
      local.getState().conversations,
    );
    expect(after.find((v) => v.id === a)).toMatchObject({
      title: 'A2',
      pinned: true,
      draft: 'wip',
    });
  });

  it('sums totals, ignoring muted counts but keeping their mentions', () => {
    const muted = conversationIdFor('m');
    const local = createLocalStore();
    local.getState().setMuted(muted, { until: 2000 });
    const unread = { [conv]: { count: 2, mentions: 0 }, [muted]: { count: 5, mentions: 1 } };
    expect(totalUnread(unread, local.getState().conversations, [conv, muted], 1000)).toEqual({
      count: 2,
      mentions: 1,
      hasUnread: true,
    });
    // After the mute lapses, its count is included.
    expect(totalUnread(unread, local.getState().conversations, [conv, muted], 3000).count).toBe(7);
  });
});

describe('lastMessage previews', () => {
  it('keeps the newest by seq and follows updates of the same message', () => {
    const store = createConversationsStore();
    const a = makeMessage({ conversationId: conv, authorId: 'a', sentAt: 1, seq: 5, body: 'a' });
    const older = makeMessage({ conversationId: conv, authorId: 'b', sentAt: 2, seq: 3 });
    store.getState().noteLatest(a);
    store.getState().noteLatest(older);
    expect(conversationsSelectors.lastMessage(conv)(store.getState())).toBe(a);
    const edited = { ...a, body: 'edited' };
    store.getState().noteLatest(edited);
    expect(store.getState().lastMessage[conv]?.body).toBe('edited');
  });

  it('swaps an optimistic message for its acknowledged form via the nonce', () => {
    const store = createConversationsStore();
    const pending = makeMessage({ conversationId: conv, authorId: SELF, seq: 9, nonce: 'n1' });
    store.getState().noteLatest(pending);
    const acked = { ...pending, id: makeMessage({ sentAt: 99 }).id, seq: 9 };
    store.getState().noteLatest(acked);
    expect(store.getState().lastMessage[conv]).toBe(acked);
  });
});
