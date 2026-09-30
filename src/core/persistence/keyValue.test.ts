import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  bindPersistence,
  createMemoryStorage,
  isRecord,
  loadVersioned,
  saveVersioned,
  type VersionedSchema,
} from './keyValue';

interface V2 {
  name: string;
  size: number;
}

const schema: VersionedSchema<V2> = {
  key: 'test',
  version: 2,
  defaults: () => ({ name: 'default', size: 10 }),
  migrations: {
    // v1 stored `{ title }`; v2 renamed it to `name` and added `size`.
    2: (data) => (isRecord(data) ? { name: data.title, size: 12 } : data),
  },
  parse: (data) =>
    isRecord(data) && typeof data.name === 'string' && typeof data.size === 'number'
      ? { name: data.name, size: data.size }
      : null,
};

describe('versioned key/value', () => {
  it('returns defaults when missing, corrupt, invalid or from the future', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(loadVersioned(createMemoryStorage(), schema)).toEqual({ name: 'default', size: 10 });
    expect(loadVersioned(createMemoryStorage({ test: '{nope' }), schema).name).toBe('default');
    expect(
      loadVersioned(createMemoryStorage({ test: '{"v":2,"data":{"name":1}}' }), schema).name,
    ).toBe('default');
    expect(loadVersioned(createMemoryStorage({ test: '{"v":9,"data":{}}' }), schema).name).toBe(
      'default',
    );
  });

  it('migrates old versions step by step', () => {
    const storage = createMemoryStorage({ test: JSON.stringify({ v: 1, data: { title: 'old' } }) });
    expect(loadVersioned(storage, schema)).toEqual({ name: 'old', size: 12 });
  });

  it('round-trips saved values', () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, schema, { name: 'x', size: 3 });
    expect(loadVersioned(storage, schema)).toEqual({ name: 'x', size: 3 });
  });

  it('persists a store slice only when it changes', () => {
    const storage = createMemoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const store = createStore<{ data: V2; other: number }>()(() => ({
      data: { name: 'a', size: 1 },
      other: 0,
    }));
    const off = bindPersistence(store, storage, schema, (s) => s.data);
    store.setState({ other: 1 });
    expect(setItem).not.toHaveBeenCalled();
    store.setState({ data: { name: 'b', size: 2 } });
    expect(setItem).toHaveBeenCalledOnce();
    off();
    store.setState({ data: { name: 'c', size: 3 } });
    expect(loadVersioned(storage, schema).name).toBe('b');
  });
});
