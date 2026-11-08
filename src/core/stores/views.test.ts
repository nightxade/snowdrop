import { describe, expect, it } from 'vitest';
import type { ConversationId } from '@/core/domain';
import { attentionOf, needsAttention, totalUnread, unreadConversationIds } from './views';
import type { LocalState } from './local';

const id = (key: string) => key as ConversationId;
const NOW = 1_000;

describe('attentionOf', () => {
  it('counts unread for a normal chat', () => {
    expect(attentionOf({ count: 3, mentions: 1 }, false, false)).toEqual({
      count: 3,
      mentions: 1,
      hasUnread: true,
    });
  });

  it('gives a muted chat no count and no dot, but keeps its mentions', () => {
    const muted = attentionOf({ count: 3, mentions: 2 }, true, true);
    expect(muted).toEqual({ count: 0, mentions: 2, hasUnread: false });
    expect(needsAttention(muted)).toBe(true);
    expect(needsAttention(attentionOf({ count: 3, mentions: 0 }, true, false))).toBe(false);
  });

  it('counts a chat marked unread as one, unless a mention already says so', () => {
    expect(attentionOf(undefined, false, true)).toEqual({ count: 1, mentions: 0, hasUnread: true });
    expect(attentionOf({ count: 0, mentions: 1 }, false, true)).toEqual({
      count: 0,
      mentions: 1,
      hasUnread: false,
    });
    expect(needsAttention(attentionOf({ count: 0, mentions: 1 }, false, true))).toBe(true);
  });

  it('is quiet for a read chat', () => {
    expect(needsAttention(attentionOf(undefined, false, false))).toBe(false);
    expect(needsAttention(attentionOf({ count: 0, mentions: 0 }, false, false))).toBe(false);
  });
});

describe('totalUnread and unreadConversationIds', () => {
  const base = { pinned: false, muted: false, archived: false };
  const local: LocalState['conversations'] = {
    [id('a')]: base,
    [id('muted')]: { ...base, muted: true },
    [id('marked')]: { ...base, markedUnread: true },
    [id('old')]: { ...base, archived: true },
  };
  const unread = {
    a: { count: 2, mentions: 0 },
    muted: { count: 5, mentions: 1 },
    old: { count: 9, mentions: 4 },
  };
  const ids = ['a', 'muted', 'marked', 'old', 'read'].map(id);

  it('adds up what the rows show: muted adds mentions only, marked adds one, archived nothing', () => {
    expect(totalUnread(unread, local, ids, NOW)).toEqual({
      count: 3,
      mentions: 1,
      hasUnread: true,
    });
  });

  it('lists unread or marked chats, muted included; archived ones only when asked', () => {
    expect(unreadConversationIds(unread, local, ids)).toEqual([id('a'), id('muted'), id('marked')]);
    expect(unreadConversationIds(unread, local, ids, { includeArchived: true })).toEqual([
      id('a'),
      id('muted'),
      id('marked'),
      id('old'),
    ]);
  });
});
