import { describe, expect, it } from 'vitest';
import { directConversationId } from '@/core/domain';
import { conversationIdFor } from '@/core/domain/testing';
import { createMemoryStorage, loadVersioned, saveVersioned } from '@/core/persistence';
import {
  createLocalStore,
  defaultLocalData,
  localSchema,
  localSelectors,
  MAX_RECENT_STICKERS,
  mergeLocalData,
  selectLocalData,
} from './local';

const a = conversationIdFor('a');
const b = conversationIdFor('b');

describe('localStore', () => {
  it('stores drafts, dropping blank ones', () => {
    const store = createLocalStore();
    store.getState().setDraft(a, 'hello');
    expect(localSelectors.draft(a)(store.getState())).toBe('hello');
    store.getState().setDraft(a, '   ');
    expect(store.getState().conversations[a]?.draft).toBeUndefined();
    const before = store.getState().conversations;
    store.getState().setDraft(a, '');
    expect(store.getState().conversations).toBe(before);
  });

  it('keeps the mentions picked for a draft, and drops them with it', () => {
    const store = createLocalStore();
    const picked = [{ id: 'u1', label: '@Ada' }];
    store.getState().setDraftMentions(a, picked);
    expect(localSelectors.draftMentions(a)(store.getState())).toBeUndefined(); // no draft yet
    store.getState().setDraft(a, 'hi @Ada');
    store.getState().setDraftMentions(a, picked);
    expect(localSelectors.draftMentions(a)(store.getState())).toEqual(picked);
    store.getState().setDraftMentions(a, []);
    expect(store.getState().conversations[a]?.draftMentions).toBeUndefined();
    store.getState().setDraftMentions(a, picked);
    store.getState().setDraft(a, '  ');
    expect(store.getState().conversations[a]?.draftMentions).toBeUndefined();
  });

  it('stores notes, pins, mutes and archive flags', () => {
    const store = createLocalStore();
    store.getState().setNote('c1', 'met at the crag');
    store.getState().setPinned(a, true);
    store.getState().setMuted(a, { until: 5 });
    store.getState().setArchived(a, true);
    expect(localSelectors.note('c1')(store.getState())).toBe('met at the crag');
    expect(localSelectors.conversation(a)(store.getState())).toEqual({
      pinned: false,
      muted: { until: 5 },
      archived: true,
    });
    store.getState().setNote('c1', '');
    expect(store.getState().contactNotes).toEqual({});
  });

  it('archiving unpins, pinning unarchives, and new activity unarchives only an archived chat', () => {
    const store = createLocalStore();
    store.getState().setPinned(a, true);
    store.getState().setArchived(a, true);
    expect(store.getState().conversations[a]).toMatchObject({ pinned: false, archived: true });
    store.getState().setPinned(a, true);
    expect(store.getState().conversations[a]).toMatchObject({ pinned: true, archived: false });
    store.getState().setArchived(a, true);
    store.getState().unarchive(a);
    expect(store.getState().conversations[a]).toMatchObject({ pinned: false, archived: false });
    const before = store.getState().conversations;
    store.getState().unarchive(a);
    store.getState().unarchive(b);
    expect(store.getState().conversations).toBe(before);
  });

  it('remembers which voice notes were played here, keeping the first time, and survives a reload', () => {
    const store = createLocalStore();
    expect(localSelectors.voiceNotePlayed('x\u00001')(store.getState())).toBe(false);
    store.getState().markVoiceNotePlayed('x\u00001');
    const first = store.getState().playedVoiceNotes['x\u00001'];
    expect(localSelectors.voiceNotePlayed('x\u00001')(store.getState())).toBe(true);
    const before = store.getState().playedVoiceNotes;
    store.getState().markVoiceNotePlayed('x\u00001');
    expect(store.getState().playedVoiceNotes).toBe(before);
    expect(store.getState().playedVoiceNotes['x\u00001']).toBe(first);

    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).playedVoiceNotes).toEqual(before);
  });

  it('caps the played list, dropping the oldest, and ignores junk on load', () => {
    const store = createLocalStore();
    for (let i = 0; i < 1010; i++) store.getState().markVoiceNotePlayed(`k${i}`);
    const played = store.getState().playedVoiceNotes;
    expect(Object.keys(played).length).toBe(1000);
    // Played within the same millisecond, the first ones go and the latest stay.
    expect(played.k0).toBeUndefined();
    expect(played.k9).toBeUndefined();
    expect(played.k10).toBeDefined();
    expect(played.k1009).toBeDefined();
    const junk = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: { playedVoiceNotes: { good: 5, bad: 'x', neg: -1 } },
      }),
    });
    expect(loadVersioned(junk, localSchema).playedVoiceNotes).toEqual({ good: 5 });
  });

  it('marks a conversation unread, locally, and clears it without leaving a trace', () => {
    const store = createLocalStore();
    store.getState().setMarkedUnread(a, false);
    expect(store.getState().conversations[a]).toBeUndefined();
    store.getState().setMarkedUnread(a, true);
    expect(store.getState().conversations[a]?.markedUnread).toBe(true);
    const before = store.getState().conversations;
    store.getState().setMarkedUnread(a, true);
    expect(store.getState().conversations).toBe(before);
    store.getState().setMarkedUnread(a, false);
    expect(localSelectors.conversation(a)(store.getState())).toEqual({
      pinned: false,
      muted: false,
      archived: false,
    });
  });

  it('persists the flag and still loads data saved before it existed', () => {
    const store = createLocalStore();
    store.getState().setMarkedUnread(a, true);
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).conversations[a]).toEqual({
      pinned: false,
      muted: false,
      archived: false,
      markedUnread: true,
    });
    const legacy = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: { conversations: { [a]: { pinned: true, muted: false, archived: false } } },
      }),
    });
    expect(loadVersioned(legacy, localSchema).conversations[a]).toEqual({
      pinned: true,
      muted: false,
      archived: false,
    });
    const odd = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: { conversations: { [a]: { markedUnread: 'yes' } } },
      }),
    });
    expect(loadVersioned(odd, localSchema).conversations[a]?.markedUnread).toBeUndefined();
  });

  it('seeds demo defaults once', () => {
    const store = createLocalStore();
    store.getState().seedDefaults({ pinned: [a] });
    store.getState().setPinned(a, false);
    store.getState().seedDefaults({ pinned: [a] });
    expect(localSelectors.conversation(a)(store.getState()).pinned).toBe(false);
  });

  it('round-trips a draft with its picked mentions, and ignores malformed ones', () => {
    const store = createLocalStore();
    store.getState().setDraft(a, 'hi @Ada');
    store.getState().setDraftMentions(a, [{ id: 'u1', label: '@Ada' }]);
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).conversations[a]?.draftMentions).toEqual([
      { id: 'u1', label: '@Ada' },
    ]);
    const odd = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: {
          conversations: {
            'group:x': { draft: 'hi', draftMentions: [{ id: 1 }, 'x', { id: 'a', label: '@A' }] },
          },
        },
      }),
    });
    expect(
      loadVersioned(odd, localSchema).conversations['group:x' as typeof a]?.draftMentions,
    ).toEqual([{ id: 'a', label: '@A' }]);
  });

  it('round-trips through storage and repairs bad data', () => {
    const store = createLocalStore();
    store.getState().setDraft(a, 'draft');
    store.getState().setMuted(a, true);
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).conversations[a]).toEqual({
      pinned: false,
      muted: true,
      archived: false,
      draft: 'draft',
    });
    const broken = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: {
          conversations: { 'group:x': { muted: 'yes', draft: 3 }, 'not-an-id': { pinned: true } },
          contactNotes: { c: 4 },
        },
      }),
    });
    expect(loadVersioned(broken, localSchema)).toEqual({
      customEmoji: [],
      conversations: { 'group:x': { pinned: false, muted: false, archived: false } },
      contactNotes: {},
      reactionUsage: {},
      backfillRequested: {},
      playedVoiceNotes: {},
      acceptedChats: {},
      deletedChats: {},
      unreadActivity: {},
      requestsSeeded: false,
      recentStickers: [],
      seeded: false,
    });
  });

  it('round-trips accepted and deleted chats and drops malformed entries', () => {
    const store = createLocalStore();
    store.getState().markAccepted(a, 5);
    store.getState().markDeleted(directConversationId('gone'), 6);
    store.getState().grandfather([], 7);
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    const loaded = loadVersioned(storage, localSchema);
    expect(loaded.acceptedChats).toEqual({ [a]: 5 });
    expect(loaded.deletedChats).toEqual({ [directConversationId('gone')]: 6 });
    expect(loaded.requestsSeeded).toBe(true);
    const broken = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: { acceptedChats: { 'not-an-id': 1, [a]: 'soon', 'group:x': 2 }, deletedChats: 4 },
      }),
    });
    const repaired = loadVersioned(broken, localSchema);
    expect(repaired.acceptedChats).toEqual({ 'group:x': 2 });
    expect(repaired.deletedChats).toEqual({});
    expect(repaired.requestsSeeded).toBe(false);
  });

  it('merges verdicts without letting a deleted chat come back accepted', () => {
    const x = directConversationId('x');
    const y = directConversationId('y');
    const existing = { ...defaultLocalData(), acceptedChats: { [x]: 1 }, requestsSeeded: true };
    const incoming = {
      ...defaultLocalData(),
      acceptedChats: { [y]: 2 },
      deletedChats: { [x]: 3, [a]: 4 },
    };
    const merged = mergeLocalData(existing, incoming);
    expect(merged.acceptedChats).toEqual({ [x]: 1, [y]: 2 });
    expect(merged.deletedChats).toEqual({ [a]: 4 });
    expect(merged.requestsSeeded).toBe(true);
  });

  it('keeps unread reactions and votes per conversation, and forgets them when dropped', () => {
    const store = createLocalStore();
    expect(localSelectors.hasUnreadActivity(a)(store.getState())).toBe(false);
    store.getState().noteUnreadActivity(a, 10);
    store.getState().noteUnreadActivity(a, 20);
    store.getState().noteUnreadActivity(b, 10);
    const before = store.getState().unreadActivity;
    store.getState().noteUnreadActivity(a, 20);
    expect(store.getState().unreadActivity).toBe(before);
    expect(localSelectors.hasUnreadActivity(a)(store.getState())).toBe(true);
    store.getState().dropUnreadActivity(10);
    expect(store.getState().unreadActivity).toEqual({ [a]: [20] });
    store.getState().dropUnreadActivity(20);
    expect(store.getState().unreadActivity).toEqual({});
  });

  it('caps unread activity per conversation, survives a reload and ignores junk on load', () => {
    const store = createLocalStore();
    for (let i = 1; i <= 110; i++) store.getState().noteUnreadActivity(a, i);
    const kept = store.getState().unreadActivity[a]!;
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe(11);
    expect(kept.at(-1)).toBe(110);
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).unreadActivity).toEqual({ [a]: kept });
    const junk = createMemoryStorage({
      [localSchema.key]: JSON.stringify({
        v: 1,
        data: { unreadActivity: { [a]: [5, 'x', -1, 5, 1.5, 7], [b]: 'no', nonsense: [1] } },
      }),
    });
    expect(loadVersioned(junk, localSchema).unreadActivity).toEqual({ [a]: [5, 7] });
  });

  it('merges unread activity as a union, oldest first', () => {
    const merged = mergeLocalData(
      { ...defaultLocalData(), unreadActivity: { [a]: [30, 10] } },
      { ...defaultLocalData(), unreadActivity: { [a]: [20, 10], [b]: [5] } },
    );
    expect(merged.unreadActivity).toEqual({ [a]: [10, 20, 30], [b]: [5] });
  });

  it('tracks reaction usage and offers the three most used', () => {
    const store = createLocalStore();
    expect(localSelectors.quickReactions(store.getState())).toEqual(['👍', '❤️', '😂']);
    store.getState().noteReactionUsed('🎯');
    store.getState().noteReactionUsed('🎯');
    store.getState().noteReactionUsed('🎉');
    expect(localSelectors.quickReactions(store.getState())).toEqual(['🎯', '🎉', '👍']);
  });

  it('keeps the most recent stickers first, once each, capped', () => {
    const store = createLocalStore();
    const note = (s: { packId: string; stickerId: number; emoji?: string }) => {
      store.getState().noteStickerSent(s);
    };
    note({ packId: 'aa01', stickerId: 1, emoji: '😀' });
    note({ packId: 'aa01', stickerId: 2 });
    note({ packId: 'aa01', stickerId: 1, emoji: '😀' });
    expect(store.getState().recentStickers).toEqual([
      { packId: 'aa01', stickerId: 1, emoji: '😀' },
      { packId: 'aa01', stickerId: 2 },
    ]);
    for (let i = 0; i < 40; i++) note({ packId: 'bb02', stickerId: i });
    expect(store.getState().recentStickers).toHaveLength(MAX_RECENT_STICKERS);
    expect(store.getState().recentStickers[0]).toEqual({ packId: 'bb02', stickerId: 39 });
  });

  it('ignores a malformed sticker and strips anything that is not an identifier', () => {
    const store = createLocalStore();
    store.getState().noteStickerSent({ packId: 'NOT HEX', stickerId: 1 });
    store.getState().noteStickerSent({
      packId: 'aa01',
      stickerId: 1,
      url: 'blob:x',
      key: 'secret',
    } as never);
    expect(store.getState().recentStickers).toEqual([{ packId: 'aa01', stickerId: 1 }]);
  });

  it('persists recent stickers per account data and tolerates data saved before they existed', () => {
    const storage = createMemoryStorage();
    const store = createLocalStore();
    store.getState().noteStickerSent({ packId: 'aa01', stickerId: 7, emoji: '🎉' });
    saveVersioned(storage, localSchema, selectLocalData(store.getState()));
    expect(loadVersioned(storage, localSchema).recentStickers).toEqual([
      { packId: 'aa01', stickerId: 7, emoji: '🎉' },
    ]);
    expect(localSchema.parse({ conversations: {} })?.recentStickers).toEqual([]);
    expect(
      localSchema.parse({
        recentStickers: [{ packId: 'zz', stickerId: 1 }, { packId: 'ab', stickerId: 2 }, 5],
      })?.recentStickers,
    ).toEqual([{ packId: 'ab', stickerId: 2 }]);
  });
});
