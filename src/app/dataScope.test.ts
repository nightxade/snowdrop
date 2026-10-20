import { describe, expect, it } from 'vitest';
import { createMemoryStorage, loadVersioned, saveVersioned } from '@/core/persistence';
import {
  createLocalStore,
  createSpacesStore,
  localSchema,
  mergeLocalData,
  mergeSpacesData,
  selectLocalData,
  selectSpacesData,
  spacesSchema,
} from '@/core/stores';
import {
  isPendingScope,
  migrateLegacyScope,
  rebindScopedStore,
  scopedKey,
  scopedSchema,
  scopeFor,
} from './dataScope';

describe('scopeFor / isPendingScope / scopedKey / scopedSchema', () => {
  it('the demo always scopes to "demo", regardless of account', () => {
    expect(scopeFor('mock', null)).toBe('demo');
    expect(scopeFor('mock', 'anything')).toBe('demo');
  });

  it('every other backend scopes by account, falling back to a pending placeholder', () => {
    expect(scopeFor('signal-cli', null)).toBe('signal-cli:pending');
    expect(scopeFor('signal-cli', '+15551234567')).toBe('signal-cli:+15551234567');
  });

  it('only a pending placeholder reports as pending', () => {
    expect(isPendingScope('signal-cli:pending')).toBe(true);
    expect(isPendingScope('signal-cli:+15551234567')).toBe(false);
    expect(isPendingScope('demo')).toBe(false);
  });

  it('scopedKey/scopedSchema suffix the base key and keep the rest of the schema', () => {
    expect(scopedKey('snowdrop.spaces', 'demo')).toBe('snowdrop.spaces:demo');
    const scoped = scopedSchema(spacesSchema, 'demo');
    expect(scoped.key).toBe('snowdrop.spaces:demo');
    expect(scoped.version).toBe(spacesSchema.version);
    expect(scoped.parse).toBe(spacesSchema.parse);
  });
});

describe('migrateLegacyScope', () => {
  it('does nothing when there is no legacy key', () => {
    const storage = createMemoryStorage();
    migrateLegacyScope(storage, spacesSchema, 'demo', mergeSpacesData);
    expect(storage.keys?.()).toEqual([]);
  });

  it('moves seeded legacy data to the demo scope, even when another backend is active', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, spacesSchema, {
      spaces: {},
      rail: [],
      homeCollapsed: { conversations: false, direct: false, groups: false },
      seeded: true,
    });
    migrateLegacyScope(storage, spacesSchema, 'signal-cli:+1', mergeSpacesData);
    expect(storage.getItem(spacesSchema.key)).toBeNull();
    expect(loadVersioned(storage, scopedSchema(spacesSchema, 'demo')).seeded).toBe(true);
    expect(storage.getItem(scopedKey(spacesSchema.key, 'signal-cli:+1'))).toBeNull();
  });

  it('moves unseeded legacy data to the active scope', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, localSchema, {
      customEmoji: [],
      conversations: {},
      contactNotes: { alice: 'met at work' },
      reactionUsage: {},
      backfillRequested: {},
      recentStickers: [],
      seeded: false,
    });
    migrateLegacyScope(storage, localSchema, 'signal-cli:+1', mergeLocalData);
    expect(storage.getItem(localSchema.key)).toBeNull();
    expect(loadVersioned(storage, scopedSchema(localSchema, 'signal-cli:+1')).contactNotes).toEqual(
      { alice: 'met at work' },
    );
    expect(storage.getItem(scopedKey(localSchema.key, 'demo'))).toBeNull();
  });

  it('merges into existing data already at the target scope instead of overwriting it', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, scopedSchema(localSchema, 'demo'), {
      customEmoji: [],
      conversations: {},
      contactNotes: { alice: 'already here' },
      reactionUsage: {},
      backfillRequested: {},
      recentStickers: [],
      seeded: true,
    });
    saveVersioned(storage, localSchema, {
      customEmoji: [],
      conversations: {},
      contactNotes: { alice: 'legacy value', bob: 'legacy only' },
      reactionUsage: {},
      backfillRequested: {},
      recentStickers: [],
      seeded: true,
    });
    migrateLegacyScope(storage, localSchema, 'signal-cli:+1', mergeLocalData);
    const merged = loadVersioned(storage, scopedSchema(localSchema, 'demo'));
    // The scope's own prior data wins on a conflict…
    expect(merged.contactNotes.alice).toBe('already here');
    // …but anything only the legacy data had is still added.
    expect(merged.contactNotes.bob).toBe('legacy only');
  });
});

describe('rebindScopedStore', () => {
  it('carries forward in-memory data as-is when the new scope has none yet', () => {
    const storage = createMemoryStorage();
    const store = createSpacesStore();
    store.getState().createSpace({ name: 'Pending project' });
    rebindScopedStore({
      store,
      storage,
      schema: spacesSchema,
      select: selectSpacesData,
      scope: 'signal-cli:acc1',
      previousScope: 'signal-cli:pending',
      merge: mergeSpacesData,
    });
    const persisted = loadVersioned(storage, scopedSchema(spacesSchema, 'signal-cli:acc1'));
    expect(Object.values(persisted.spaces).map((s) => s.name)).toEqual(['Pending project']);
  });

  it('removes the old key only when it was a pending placeholder', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, scopedSchema(spacesSchema, 'signal-cli:pending'), {
      spaces: {},
      rail: [],
      homeCollapsed: { conversations: false, direct: false, groups: false },
      seeded: false,
    });
    rebindScopedStore({
      store: createSpacesStore(),
      storage,
      schema: spacesSchema,
      select: selectSpacesData,
      scope: 'signal-cli:acc1',
      previousScope: 'signal-cli:pending',
      merge: mergeSpacesData,
    });
    expect(storage.getItem(scopedKey(spacesSchema.key, 'signal-cli:pending'))).toBeNull();

    const storage2 = createMemoryStorage();
    saveVersioned(storage2, scopedSchema(spacesSchema, 'signal-cli:acc1'), {
      spaces: {},
      rail: [],
      homeCollapsed: { conversations: false, direct: false, groups: false },
      seeded: false,
    });
    rebindScopedStore({
      store: createSpacesStore(),
      storage: storage2,
      schema: spacesSchema,
      select: selectSpacesData,
      scope: 'signal-cli:acc2',
      previousScope: 'signal-cli:acc1',
      merge: mergeSpacesData,
    });
    // acc1 is a real account's own scope, never deleted just because a
    // different account was discovered for the same backend.
    expect(storage2.getItem(scopedKey(spacesSchema.key, 'signal-cli:acc1'))).not.toBeNull();
  });

  it('folds in-memory changes into the new scope’s existing data, which wins on conflicts', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, scopedSchema(localSchema, 'signal-cli:acc1'), {
      customEmoji: [],
      conversations: {},
      contactNotes: { alice: 'known already' },
      reactionUsage: {},
      backfillRequested: {},
      recentStickers: [],
      seeded: false,
    });
    const store = createLocalStore();
    store.getState().setNote('bob', 'written before the account resolved');
    rebindScopedStore({
      store,
      storage,
      schema: localSchema,
      select: selectLocalData,
      scope: 'signal-cli:acc1',
      previousScope: 'signal-cli:pending',
      merge: mergeLocalData,
    });
    expect(store.getState().contactNotes).toEqual({
      alice: 'known already',
      bob: 'written before the account resolved',
    });
  });

  it('returns a binding that persists further changes under the new scope', () => {
    const storage = createMemoryStorage();
    const store = createSpacesStore();
    const binding = rebindScopedStore({
      store,
      storage,
      schema: spacesSchema,
      select: selectSpacesData,
      scope: 'signal-cli:acc1',
      previousScope: 'signal-cli:pending',
      merge: mergeSpacesData,
    });
    store.getState().createSpace({ name: 'After rebind' });
    binding.flush();
    const persisted = loadVersioned(storage, scopedSchema(spacesSchema, 'signal-cli:acc1'));
    expect(Object.values(persisted.spaces).map((s) => s.name)).toEqual(['After rebind']);
  });
});

it('keeps personal emoji separate across accounts and demo storage', () => {
  const storage = createMemoryStorage();
  const local = createLocalStore();
  local
    .getState()
    .saveCustomEmoji({ kind: 'image', name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' });
  saveVersioned(
    storage,
    scopedSchema(localSchema, scopeFor('mock', null)),
    selectLocalData(local.getState()),
  );
  saveVersioned(
    storage,
    scopedSchema(localSchema, scopeFor('signal-cli', '+15550000001')),
    selectLocalData(local.getState()),
  );
  expect(
    loadVersioned(storage, scopedSchema(localSchema, scopeFor('signal-cli', '+15550000002')))
      .customEmoji,
  ).toEqual([]);
  expect(
    loadVersioned(storage, scopedSchema(localSchema, scopeFor('signal-cli', '+15550000001')))
      .customEmoji,
  ).toHaveLength(1);
});
