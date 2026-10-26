/**
 * Per-backend, per-account storage scoping for spaces and local state
 * (`core/stores/spaces.ts`, `core/stores/local.ts`): both used to persist
 * under one global key, so the demo's seeded spaces and any local state
 * created while trying it out (pins, mutes, notes, drafts) leaked straight
 * into a real signal-cli account once the user connected one — same browser
 * storage, same key, no distinction between "the demo" and "my account".
 *
 * The fix is a key suffix per scope: the demo always uses `:demo`; every
 * other backend is scoped by account, `:<kind>:<accountId>`, with a
 * `:<kind>:pending` placeholder until the account is known (signal-cli
 * reports it asynchronously — see `onAccountSelected` in `app/backends.ts`
 * and its wiring in `createSnowdrop.ts`). Settings (themes, keybinds,
 * plugins, the connection itself) stay on their own unscoped key: they're
 * the same regardless of which account is in use.
 *
 * `migrateLegacyScope` runs once at boot to move data written before this
 * scoping existed to the right scope. `rebindScopedStore` runs whenever a
 * signal-cli account becomes known after boot (it wasn't yet when storage
 * was first loaded), moving the pending scope's data to the account's own
 * scope without losing anything written in between.
 */
import {
  CURSOR_KEY_PREFIX,
  leftGroupsStorageKey,
  peersStorageKey,
} from '@/core/backend/signal-cli/storageKeys';
import { HISTORY_IMPORT_KEY_PREFIX } from '@/core/services';
import { localSchema } from '@/core/stores';
import {
  backupKey,
  bindPersistence,
  loadVersioned,
  saveVersioned,
  type KeyValueStorage,
  type PersistenceBinding,
  type VersionedSchema,
} from '@/core/persistence';
import type { StoreApi } from 'zustand/vanilla';

/** A key suffix, e.g. `demo`, `signal-cli:pending`, `signal-cli:+15551234567`. */
export type StorageScope = string;

const PENDING_SUFFIX = ':pending';

/**
 * The scope for a backend/account pair. The demo has one fixed scope
 * (there's only ever one demo, and it's never a real account); anything
 * else is scoped by account, falling back to a pending placeholder — never
 * to the backend alone — so an unknown account's data is never mixed with
 * a different account's later, nor with the demo's.
 */
export function scopeFor(kind: string, accountId: string | null): StorageScope {
  if (kind === 'mock') return 'demo';
  return accountId ? `${kind}:${accountId}` : `${kind}${PENDING_SUFFIX}`;
}

/** True for a placeholder scope awaiting `rebindScopedStore`. */
export function isPendingScope(scope: StorageScope): boolean {
  return scope.endsWith(PENDING_SUFFIX);
}

/** The account id a scope was made for; null for the demo and for a pending placeholder. */
export function accountOfScope(scope: StorageScope): string | null {
  if (scope === 'demo' || isPendingScope(scope)) return null;
  const at = scope.indexOf(':');
  return at < 0 ? null : scope.slice(at + 1);
}

/**
 * Every storage key that belongs to one signed-out account (README,
 * "Signing out"): the account's local state (`snowdrop.local:<scope>`:
 * contact notes, pins, mutes, drafts, accepted/deleted message requests,
 * recent stickers, reaction usage, backfill markers), its imported-history
 * record, the signal-cli adapter's peers list and resume cursors, and the
 * `.backup` copies the loader parks next to any of them. The `pending`
 * placeholder scope of the same backend goes too: it only ever holds what was
 * written before the account was known.
 *
 * Deliberately not here: settings and themes (unscoped) and the account's
 * spaces (`snowdrop.spaces:<scope>`), which sign-out promises to keep.
 *
 * `storageKeys` is what the store currently holds; only keys that exist are
 * returned. The cursor keys end in the account id, so they are found by suffix.
 */
export function accountDataKeys(
  storageKeys: readonly string[],
  kind: string,
  accountId: string | null,
): string[] {
  if (kind === 'mock') return [];
  const present = new Set(storageKeys);
  const wanted = new Set<string>();
  for (const scope of new Set([scopeFor(kind, accountId), scopeFor(kind, null)])) {
    for (const base of [localSchema.key, HISTORY_IMPORT_KEY_PREFIX]) {
      const key = scopedKey(base, scope);
      wanted.add(key);
      wanted.add(backupKey(key));
    }
  }
  if (accountId) {
    wanted.add(peersStorageKey(accountId));
    wanted.add(leftGroupsStorageKey(accountId));
    for (const key of storageKeys) {
      if (key.startsWith(CURSOR_KEY_PREFIX) && key.endsWith(`.${accountId}`)) wanted.add(key);
    }
  }
  return [...wanted].filter((key) => present.has(key));
}

export function scopedKey(baseKey: string, scope: StorageScope): string {
  return `${baseKey}:${scope}`;
}

export function scopedSchema<T>(
  schema: VersionedSchema<T>,
  scope: StorageScope,
): VersionedSchema<T> {
  return { ...schema, key: scopedKey(schema.key, scope) };
}

/**
 * Moves a pre-scoping global key to its proper scope, once; a no-op on
 * every later boot, since it deletes the legacy key once done.
 *
 * Seeded data (`seeded === true`) only ever came from the demo's
 * `seedDefaults`, so it always moves to `demo`, regardless of which backend
 * is active now. Anything else belonged to whatever backend/account was
 * active when it was written, which — absent any record of that — is the
 * best guess available: `activeScope`, the scope this boot resolves to for
 * the backend currently selected (a signal-cli account not yet known at
 * this boot resolves to its pending placeholder, and `rebindScopedStore`
 * carries it the rest of the way once `onAccountSelected` fires).
 *
 * Works through `KeyValueStorage` alone (never raw `localStorage`), so it
 * runs the same way for the plaintext browser build and the desktop app's
 * encrypted storage (`HydratedKeyValue` has already decrypted the legacy
 * key, sealed or not, by the time this reads it).
 */
export function migrateLegacyScope<T extends { seeded: boolean }>(
  storage: KeyValueStorage,
  schema: VersionedSchema<T>,
  activeScope: StorageScope,
  merge: (existing: T, incoming: T) => T,
): void {
  if (storage.getItem(schema.key) === null) return;
  const legacy = loadVersioned(storage, schema);
  const target = scopedSchema(schema, legacy.seeded ? 'demo' : activeScope);
  const existingRaw = storage.getItem(target.key);
  const data = existingRaw === null ? legacy : merge(loadVersioned(storage, target), legacy);
  saveVersioned(storage, target, data);
  storage.removeItem(schema.key);
}

/**
 * Rebinds a store's persistence to a new scope at runtime — a signal-cli
 * account becoming known after boot — without losing anything written
 * under the old scope in the meantime:
 *
 * - if the new scope has no data of its own, whatever's in memory now
 *   (written under the old/pending scope) simply becomes its first data;
 * - otherwise it's folded into the new scope's existing data with `merge`,
 *   which keeps that data's values on a conflict (ids are nonces, so a real
 *   collision is exceptionally unlikely) and adds anything only the
 *   in-memory state has. A merge against genuinely untouched in-memory
 *   data (nothing happened before the account resolved) is therefore just
 *   the existing data back, unchanged.
 *
 * The old binding's caller-supplied cleanup (flush/dispose of the previous
 * `PersistenceBinding`) is the caller's job, same as creating this one is
 * ours: callers replace their reference to the old binding with the one
 * this returns. The old scope's key is removed only when it was a pending
 * placeholder — a real account's own scope is never deleted just because a
 * different account was discovered for the same backend.
 */
export function rebindScopedStore<FullState extends Data, Data extends { seeded: boolean }>(args: {
  store: StoreApi<FullState>;
  storage: KeyValueStorage;
  schema: VersionedSchema<Data>;
  select: (state: FullState) => Data;
  scope: StorageScope;
  previousScope: StorageScope;
  merge: (existing: Data, incoming: Data) => Data;
  debounce?: { ms: number; schedule: (fn: () => void, ms: number) => () => void };
}): PersistenceBinding {
  const { store, storage, schema, select, scope, previousScope, merge, debounce } = args;
  const incoming = select(store.getState());
  const target = scopedSchema(schema, scope);
  const existingRaw = storage.getItem(target.key);
  const finalData =
    existingRaw === null ? incoming : merge(loadVersioned(storage, target), incoming);
  // `Data`'s fields are a subset of `FullState`'s (the `extends` constraint
  // above), but zustand's own typing of `setState` can't see that through
  // the generic — safe to assert.
  store.setState(finalData as unknown as Partial<FullState>);
  saveVersioned(storage, target, finalData);
  if (isPendingScope(previousScope)) storage.removeItem(scopedKey(schema.key, previousScope));
  return bindPersistence(store, storage, target, select, debounce);
}
