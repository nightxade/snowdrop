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

  it('stores notes, pins, mutes and archive flags', () => {
    const store = createLocalStore();
    store.getState().setNote('c1', 'met at the crag');
    store.getState().setPinned(a, true);
    store.getState().setMuted(a, { until: 5 });
    store.getState().setArchived(a, true);
    expect(localSelectors.note('c1')(store.getState())).toBe('met at the crag');
    expect(localSelectors.conversation(a)(store.getState())).toEqual({
      pinned: true,
      muted: { until: 5 },
      archived: true,
    });
    store.getState().setNote('c1', '');
    expect(store.getState().contactNotes).toEqual({});
  });

  it('seeds demo defaults once', () => {
    const store = createLocalStore();
    store.getState().seedDefaults({ pinned: [a] });
    store.getState().setPinned(a, false);
    store.getState().seedDefaults({ pinned: [a] });
    expect(localSelectors.conversation(a)(store.getState()).pinned).toBe(false);
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
      acceptedChats: {},
      deletedChats: {},
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
