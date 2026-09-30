import { describe, expect, it } from 'vitest';
import { createMemoryStorage, loadVersioned, saveVersioned } from '@/core/persistence';
import { conversationIdFor } from '@/core/domain/testing';
import {
  createSpacesStore,
  selectSpacesData,
  spacesSchema,
  spacesSelectors,
  type SpacesStore,
} from './spaces';

const [c1, c2, c3, c4] = ['1', '2', '3', '4'].map(conversationIdFor) as [
  ReturnType<typeof conversationIdFor>,
  ReturnType<typeof conversationIdFor>,
  ReturnType<typeof conversationIdFor>,
  ReturnType<typeof conversationIdFor>,
];

function setup(): SpacesStore {
  let n = 0;
  return createSpacesStore(undefined, (prefix) => `${prefix}-${++n}`);
}

const idsIn = (store: SpacesStore, spaceId: string) =>
  store.getState().spaces[spaceId]?.categories.map((c) => c.conversationIds) ?? [];

describe('spacesStore', () => {
  it('creates spaces with a default category and appends them to the rail', () => {
    const store = setup();
    const work = store
      .getState()
      .createSpace({ name: ' Work ', emoji: '🔥', conversationIds: [c1, c2, c1] });
    expect(store.getState().spaces[work]).toMatchObject({ name: 'Work', emoji: '🔥' });
    expect(idsIn(store, work)).toEqual([[c1, c2]]);
    expect(spacesSelectors.orderedIds(store.getState())).toEqual([work]);
  });

  it('keeps a conversation in at most one space', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A', conversationIds: [c1] });
    const b = store.getState().createSpace({ name: 'B', conversationIds: [c1, c2] });
    expect(idsIn(store, a)).toEqual([[]]);
    expect(idsIn(store, b)).toEqual([[c1, c2]]);
    store.getState().assign(c2, a);
    expect(idsIn(store, a)).toEqual([[c2]]);
    expect(spacesSelectors.spaceOf(c2)(store.getState())).toBe(a);
    store.getState().unassign(c2);
    expect(spacesSelectors.spaceOf(c2)(store.getState())).toBeNull();
  });

  it('shows DMs in Home even when assigned, groups only when unassigned', () => {
    const store = setup();
    store.getState().createSpace({ name: 'A', conversationIds: [c1] });
    expect(spacesSelectors.isInHome(c1, 'group')(store.getState())).toBe(false);
    expect(spacesSelectors.isInHome(c1, 'direct')(store.getState())).toBe(true);
    expect(spacesSelectors.isInHome(c2, 'group')(store.getState())).toBe(true);
  });

  it('manages categories and moves conversations between them', () => {
    const store = setup();
    const s = store.getState().createSpace({ name: 'S', conversationIds: [c1, c2, c3] });
    const cat = store.getState().addCategory(s, 'Trips')!;
    store.getState().moveConversation(c3, cat, 0);
    store.getState().moveConversation(c1, cat, 5);
    expect(idsIn(store, s)).toEqual([[c2], [c3, c1]]);
    store.getState().moveConversation(c1, cat, 0);
    expect(idsIn(store, s)).toEqual([[c2], [c1, c3]]);
    store.getState().toggleCategory(s, cat);
    expect(store.getState().spaces[s]?.categories[1]?.collapsed).toBe(true);
    expect(store.getState().removeCategory(s, cat)).toBe(true);
    expect(idsIn(store, s)).toEqual([[c2, c1, c3]]);
    // The last category cannot be removed.
    const only = store.getState().spaces[s]!.categories[0]!.id;
    expect(store.getState().removeCategory(s, only)).toBe(false);
  });

  it('moves a conversation into another space’s category', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A', conversationIds: [c1] });
    const b = store.getState().createSpace({ name: 'B' });
    const bCat = store.getState().spaces[b]!.categories[0]!.id;
    store.getState().moveConversation(c1, bCat, 0);
    expect(idsIn(store, a)).toEqual([[]]);
    expect(idsIn(store, b)).toEqual([[c1]]);
  });

  it('reorders the rail and builds folders', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A' });
    const b = store.getState().createSpace({ name: 'B' });
    const c = store.getState().createSpace({ name: 'C' });
    store.getState().moveRailEntry(2, 0);
    expect(spacesSelectors.orderedIds(store.getState())).toEqual([c, a, b]);

    const folder = store.getState().createFolder(a, c)!;
    expect(store.getState().rail).toEqual([
      { type: 'folder', id: folder, name: 'Folder', collapsed: false, spaceIds: [a, c] },
      { type: 'space', id: b },
    ]);
    // Dropping onto a folder member joins the folder.
    expect(store.getState().createFolder(c, b)).toBe(folder);
    expect(spacesSelectors.orderedIds(store.getState())).toEqual([a, c, b]);

    store.getState().removeFromFolder(b);
    store.getState().removeFromFolder(c);
    // A folder of one dissolves back into a plain tile.
    expect(store.getState().rail).toEqual([
      { type: 'space', id: a },
      { type: 'space', id: c },
      { type: 'space', id: b },
    ]);
  });

  it('deletes a space, returning its conversations to Home', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A', conversationIds: [c4] });
    const b = store.getState().createSpace({ name: 'B' });
    store.getState().createFolder(a, b);
    store.getState().deleteSpace(a);
    expect(store.getState().rail).toEqual([{ type: 'space', id: b }]);
    expect(spacesSelectors.spaceOf(c4)(store.getState())).toBeNull();
  });

  it('seeds defaults exactly once', () => {
    const store = setup();
    const seeds = [
      {
        name: 'Work',
        emoji: '🔥',
        categories: [
          { name: 'Teams', conversationIds: [c1] },
          { name: 'Social', conversationIds: [c2] },
        ],
      },
    ];
    store.getState().seedDefaults(seeds);
    store.getState().seedDefaults(seeds);
    const spaces = Object.values(store.getState().spaces);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.categories.map((c) => [c.name, c.conversationIds])).toEqual([
      ['Teams', [c1]],
      ['Social', [c2]],
    ]);
  });

  it('round-trips through versioned storage and repairs bad data', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A', conversationIds: [c1] });
    const storage = createMemoryStorage();
    saveVersioned(storage, spacesSchema, selectSpacesData(store.getState()));
    expect(loadVersioned(storage, spacesSchema).spaces[a]?.name).toBe('A');

    const broken = createMemoryStorage({
      [spacesSchema.key]: JSON.stringify({
        v: 1,
        data: {
          spaces: {
            x: {
              id: 'x',
              name: 'X',
              categories: [{ id: 'k', name: 'K', conversationIds: [c1, 5] }],
            },
            bad: 1,
          },
          rail: [{ type: 'space', id: 'ghost' }],
        },
      }),
    });
    const repaired = loadVersioned(broken, spacesSchema);
    expect(Object.keys(repaired.spaces)).toEqual(['x']);
    expect(repaired.spaces.x?.categories[0]?.conversationIds).toEqual([c1]);
    // Orphaned spaces are re-added to the rail; ghosts dropped.
    expect(repaired.rail).toEqual([{ type: 'space', id: 'x' }]);
  });

  it('drops conversations that no longer exist', () => {
    const store = setup();
    const a = store.getState().createSpace({ name: 'A', conversationIds: [c1, c2] });
    store.getState().retainConversations(new Set([c2]));
    expect(idsIn(store, a)).toEqual([[c2]]);
  });
});
