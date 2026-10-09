import { describe, expect, it } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { createMemoryStorage, loadVersioned, saveVersioned } from '@/core/persistence';
import { createLocalStore, localSchema, localSelectors, selectLocalData } from './local';

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
      seeded: false,
    });
  });

  it('tracks reaction usage and offers the three most used', () => {
    const store = createLocalStore();
    expect(localSelectors.quickReactions(store.getState())).toEqual(['👍', '❤️', '😂']);
    store.getState().noteReactionUsed('🎯');
    store.getState().noteReactionUsed('🎯');
    store.getState().noteReactionUsed('🎉');
    expect(localSelectors.quickReactions(store.getState())).toEqual(['🎯', '🎉', '👍']);
  });
});
