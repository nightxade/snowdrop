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
    const probe = '__snowdrop_probe__';
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

/** Where unreadable data is parked before defaults overwrite it. */
export const backupKey = (key: string): string => `${key}.backup`;

/**
 * Keeps a copy of data we're about to discard (corrupt JSON, a newer app
 * version's format, a failed migration) so a downgrade or bug fix can
 * recover it instead of the user silently losing their settings.
 */
function backup(storage: KeyValueStorage, key: string, raw: string, reason: string): void {
  console.warn(`[snowdrop] could not load "${key}" (${reason}); backed up to "${backupKey(key)}"`);
  try {
    storage.setItem(backupKey(key), raw);
  } catch {
    // Out of quota: nothing more we can do safely.
  }
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
    if (!isEnvelope(parsed)) {
      backup(storage, schema.key, raw, 'unrecognised format');
      return schema.defaults();
    }
    if (parsed.v > schema.version) {
      backup(storage, schema.key, raw, `written by a newer version (v${parsed.v})`);
      return schema.defaults();
    }
    let data = parsed.data;
    for (let v = parsed.v + 1; v <= schema.version; v++) {
      const migrate = schema.migrations?.[v];
      if (migrate) data = migrate(data);
    }
    const result = schema.parse(data);
    if (result === null) {
      backup(storage, schema.key, raw, 'failed validation');
      return schema.defaults();
    }
    return result;
  } catch (error) {
    backup(storage, schema.key, raw, error instanceof Error ? error.message : 'parse error');
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
    console.warn(`[snowdrop] could not save "${schema.key}"`, error);
  }
}

/** Anything with a zustand-like getState/subscribe. */
export interface Subscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export interface PersistenceBinding {
  /** Writes any pending change now. */
  flush(): void;
  /** Flushes and stops listening. */
  dispose(): void;
}

/**
 * Writes `select(state)` to storage whenever it changes (by reference).
 * With `debounce`, bursts (typing a draft, dragging a slider) are coalesced
 * into one write; `flush()` forces it (e.g. on page hide).
 */
export function bindPersistence<S, T>(
  store: Subscribable<S>,
  storage: KeyValueStorage,
  schema: VersionedSchema<T>,
  select: (state: S) => T,
  debounce?: { ms: number; schedule: (fn: () => void, ms: number) => () => void },
): PersistenceBinding {
  let last = select(store.getState());
  let pending: T | undefined;
  let cancel: (() => void) | null = null;

  const flush = (): void => {
    cancel?.();
    cancel = null;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    saveVersioned(storage, schema, value);
  };

  const unsubscribe = store.subscribe((state) => {
    const next = select(state);
    if (next === last) return;
    last = next;
    pending = next;
    if (!debounce) {
      flush();
      return;
    }
    cancel?.();
    cancel = debounce.schedule(flush, debounce.ms);
  });

  return {
    flush,
    dispose: () => {
      unsubscribe();
      flush();
    },
  };
}

/** Tiny structural guard helpers for `parse` implementations. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
