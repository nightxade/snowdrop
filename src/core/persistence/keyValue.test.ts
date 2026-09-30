import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ManualScheduler } from '@/core/lib';
import {
  backupKey,
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

  it('backs up data it cannot use before defaults overwrite it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const future = JSON.stringify({ v: 9, data: { name: 'from the future' } });
    const storage = createMemoryStorage({ test: future });
    expect(loadVersioned(storage, schema).name).toBe('default');
    expect(storage.getItem(backupKey('test'))).toBe(future);

    const corrupt = createMemoryStorage({ test: '{nope' });
    loadVersioned(corrupt, schema);
    expect(corrupt.getItem(backupKey('test'))).toBe('{nope');
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
    const binding = bindPersistence(store, storage, schema, (s) => s.data);
    store.setState({ other: 1 });
    expect(setItem).not.toHaveBeenCalled();
    store.setState({ data: { name: 'b', size: 2 } });
    expect(setItem).toHaveBeenCalledOnce();
    binding.dispose();
    store.setState({ data: { name: 'c', size: 3 } });
    expect(loadVersioned(storage, schema).name).toBe('b');
  });

  it('coalesces bursts when debounced and flushes on dispose', () => {
    const storage = createMemoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const scheduler = new ManualScheduler();
    const store = createStore<{ data: V2 }>()(() => ({ data: { name: 'a', size: 1 } }));
    const binding = bindPersistence(store, storage, schema, (s) => s.data, {
      ms: 300,
      schedule: (fn, ms) => scheduler.setTimeout(fn, ms),
    });
    for (let i = 0; i < 5; i++) store.setState({ data: { name: `n${i}`, size: i } });
    expect(setItem).not.toHaveBeenCalled();
    scheduler.advance(300);
    expect(setItem).toHaveBeenCalledOnce();
    store.setState({ data: { name: 'last', size: 9 } });
    binding.dispose();
    expect(loadVersioned(storage, schema).name).toBe('last');
  });
});
