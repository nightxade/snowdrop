import { describe, expect, it } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { createMemoryStorage, loadVersioned, saveVersioned } from '@/core/persistence';
import { createSpacesStore, selectSpacesData, spacesSchema, type SpacesStore } from './spaces';

const [c1, c2, c3] = ['1', '2', '3'].map(conversationIdFor) as [
  ReturnType<typeof conversationIdFor>,
  ReturnType<typeof conversationIdFor>,
  ReturnType<typeof conversationIdFor>,
];

function setup(): { store: SpacesStore; a: string; b: string; c: string } {
  let n = 0;
  const store = createSpacesStore(undefined, (prefix) => `${prefix}-${++n}`);
  const s = store.getState();
  return {
    store,
    a: s.createSpace({ name: 'A' }),
    b: s.createSpace({ name: 'B' }),
    c: s.createSpace({ name: 'C' }),
  };
}

describe('spaces: folders (P4)', () => {
  it('drag onto a tile creates a folder in its place; more spaces join it', () => {
    const { store, a, b, c } = setup();
    const folder = store.getState().createFolder(a, c)!;
    expect(store.getState().rail).toEqual([
      { type: 'folder', id: folder, name: 'Folder', collapsed: false, spaceIds: [a, c] },
      { type: 'space', id: b },
    ]);
    expect(store.getState().createFolder(c, b)).toBe(folder);
    expect(store.getState().rail).toEqual([
      { type: 'folder', id: folder, name: 'Folder', collapsed: false, spaceIds: [a, c, b] },
    ]);
    expect(store.getState().createFolder(a, a)).toBeNull();
  });

  it('renames, recolours and dissolves folders', () => {
    const { store, a, b, c } = setup();
    const folder = store.getState().createFolder(b, c)!;
    const s = store.getState();
    s.renameFolder(folder, '  Hobbies ');
    s.renameFolder(folder, '   ');
    s.setFolderHue(folder, 5);
    expect(store.getState().rail[1]).toMatchObject({ name: 'Hobbies', hue: 5 });
    store.getState().setFolderHue(folder, null);
    expect(store.getState().rail[1]).not.toHaveProperty('hue');
    store.getState().dissolveFolder(folder);
    expect(store.getState().rail).toEqual([
      { type: 'space', id: a },
      { type: 'space', id: b },
      { type: 'space', id: c },
    ]);
  });

  it('a folder of one turns back into a plain space when a space leaves', () => {
    const { store, a, b, c } = setup();
    store.getState().createFolder(a, b);
    store.getState().removeFromFolder(b);
    expect(store.getState().rail).toEqual([
      { type: 'space', id: a },
      { type: 'space', id: b },
      { type: 'space', id: c },
    ]);
  });

  it('places entries before/after others, pulling spaces out of folders', () => {
    const { store, a, b, c } = setup();
    store.getState().placeRailEntry(c, a, 'before');
    expect(store.getState().rail.map((e) => e.id)).toEqual([c, a, b]);
    const folder = store.getState().createFolder(a, b)!;
    store.getState().placeRailEntry(b, c, 'before');
    expect(store.getState().rail.map((e) => e.id)).toEqual([b, c, a]);
    expect(store.getState().rail.some((e) => e.id === folder)).toBe(false);
  });

  it('persists folder colour', () => {
    const { store, a, b } = setup();
    const folder = store.getState().createFolder(a, b)!;
    store.getState().setFolderHue(folder, 9);
    const storage = createMemoryStorage();
    saveVersioned(storage, spacesSchema, selectSpacesData(store.getState()));
    expect(loadVersioned(storage, spacesSchema).rail[0]).toMatchObject({ hue: 9 });
  });
});

describe('spaces: categories (P4)', () => {
  it('moves conversations between categories and within one', () => {
    const { store, a } = setup();
    const s = store.getState();
    s.assign(c1, a);
    s.assign(c2, a);
    s.assign(c3, a);
    const projects = s.addCategory(a, 'Projects')!;
    const chats = store.getState().spaces[a]!.categories[0]!.id;
    store.getState().moveConversation(c2, projects, 0);
    store.getState().moveConversation(c3, chats, 0);
    const cats = store.getState().spaces[a]!.categories;
    expect(cats.map((c) => c.conversationIds)).toEqual([[c3, c1], [c2]]);
  });

  it('moves a conversation into another space by dropping on its category', () => {
    const { store, a, b } = setup();
    store.getState().assign(c1, a);
    const target = store.getState().spaces[b]!.categories[0]!.id;
    store.getState().moveConversation(c1, target, 0);
    expect(store.getState().spaces[a]!.categories[0]!.conversationIds).toEqual([]);
    expect(store.getState().spaces[b]!.categories[0]!.conversationIds).toEqual([c1]);
  });

  it('reorders, renames and deletes categories (rows move to the first)', () => {
    const { store, a } = setup();
    const s = store.getState();
    const x = s.addCategory(a, 'X')!;
    const y = s.addCategory(a, 'Y')!;
    s.assign(c1, a, y);
    store.getState().moveCategory(a, y, 0);
    store.getState().renameCategory(a, y, 'Why');
    expect(store.getState().spaces[a]!.categories.map((c) => c.name)).toEqual([
      'Why',
      'Chats',
      'X',
    ]);
    expect(store.getState().removeCategory(a, y)).toBe(true);
    const cats = store.getState().spaces[a]!.categories;
    expect(cats.map((c) => c.id)).not.toContain(y);
    expect(cats[0]!.conversationIds).toEqual([c1]);
    expect(cats.some((c) => c.id === x)).toBe(true);
  });
});
