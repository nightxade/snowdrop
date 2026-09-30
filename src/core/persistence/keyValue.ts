/**
 * Versioned key/value persistence for small state (settings, spaces).
 *
 * Values are wrapped as `{ v, data }`. On load, stored data is migrated one
 * version at a time up to the current version, so a user coming back after
 * several releases still gets their settings. Corrupt or future-version data
 * falls back to defaults rather than crashing the app on boot.
 */

/** The subset of the Web Storage API we need; lets tests use an in-memory map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** localStorage when usable, otherwise an in-memory fallback (private mode, SSR, tests). */
export function defaultStorage(): KeyValueStorage {
  try {
    const probe = '__hearth_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

export interface VersionedSchema<T> {
  key: string;
  version: number;
  defaults: () => T;
  /** `migrations[n]` upgrades data from version n-1 to n. */
  migrations?: Record<number, (data: unknown) => unknown>;
  /**
   * Validates/normalises migrated data. Return null to reject (→ defaults).
   * Typically merges over defaults so newly added fields get sane values.
   */
  parse: (data: unknown) => T | null;
}

interface Envelope {
  v: number;
  data: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { v?: unknown }).v === 'number' &&
    'data' in value
  );
}

export function loadVersioned<T>(storage: KeyValueStorage, schema: VersionedSchema<T>): T {
  let raw: string | null;
  try {
    raw = storage.getItem(schema.key);
  } catch {
    return schema.defaults();
  }
  if (raw === null) return schema.defaults();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed) || parsed.v > schema.version) return schema.defaults();
    let data = parsed.data;
    for (let v = parsed.v + 1; v <= schema.version; v++) {
      const migrate = schema.migrations?.[v];
      if (migrate) data = migrate(data);
    }
    return schema.parse(data) ?? schema.defaults();
  } catch (error) {
    console.warn(`[hearth] could not load "${schema.key}", using defaults`, error);
    return schema.defaults();
  }
}

export function saveVersioned<T>(
  storage: KeyValueStorage,
  schema: VersionedSchema<T>,
  value: T,
): void {
  try {
    storage.setItem(schema.key, JSON.stringify({ v: schema.version, data: value }));
  } catch (error) {
    // Quota exceeded or storage disabled: keep running with in-memory state.
    console.warn(`[hearth] could not save "${schema.key}"`, error);
  }
}

/** Anything with a zustand-like getState/subscribe. */
export interface Subscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

/**
 * Writes `select(state)` to storage whenever it changes (by reference).
 * Returns an unsubscribe function.
 */
export function bindPersistence<S, T>(
  store: Subscribable<S>,
  storage: KeyValueStorage,
  schema: VersionedSchema<T>,
  select: (state: S) => T,
): () => void {
  let last = select(store.getState());
  return store.subscribe((state) => {
    const next = select(state);
    if (next === last) return;
    last = next;
    saveVersioned(storage, schema, next);
  });
}

/** Tiny structural guard helpers for `parse` implementations. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
