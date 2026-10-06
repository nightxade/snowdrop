/**
 * The persistence seam for encrypted storage (docs/ENCRYPTION.md, "Web
 * cache"). `createPersistence` is the one call the setup/unlock screens
 * (a later piece of work) need to make, once storage is `Unlocked`:
 *
 *   const cipher = await webCryptoCipher(fromBase64(await storageWebcacheKey()));
 *   const { storage, repository } = await createPersistence({ cipher });
 *   const snowdrop = createSnowdrop({ storage, repository, document });
 *
 * In the browser and dev mode, where there's no vault, the same seam is
 * used with `plaintextCipher()` instead — the cache behaves exactly as it
 * did before this feature existed.
 *
 * Nothing above this call may read or write IndexedDB or localStorage
 * beyond the bootstrap allow-list (`BOOTSTRAP_ALLOW_LIST`): that tiny,
 * explicit plaintext slice is what the unlock/setup screens read directly,
 * with `defaultStorage()`, to theme themselves before the vault opens.
 */
import {
  defaultStorage,
  hydrateKeyValue,
  isSealedValue,
  type HydratedKeyValue,
  type KeyValueStorage,
  type MessageRepository,
  type RecordCipher,
} from '@/core/persistence';

const DEFAULT_DB_NAME = 'snowdrop-signal-cli';

/**
 * Discards web cache data that can no longer be decrypted: run while storage
 * needs setup, i.e. there is no key (after "Erase all local data", "Start
 * fresh", or an erase interrupted midway). Sealed localStorage values and the
 * encrypted message database go; legacy plaintext values stay, because setup
 * migrates them (docs/ENCRYPTION.md, "Web cache"). Nothing holds the
 * database open yet at this point, so the delete can't be blocked.
 */
export async function discardUnreadableWebCache({
  storage = defaultStorage(),
  dbName = DEFAULT_DB_NAME,
}: { storage?: KeyValueStorage; dbName?: string } = {}): Promise<void> {
  for (const key of storage.keys?.() ?? []) {
    const raw = storage.getItem(key);
    if (raw !== null && isSealedValue(raw)) storage.removeItem(key);
  }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess =
      request.onerror =
      request.onblocked =
        () => {
          resolve();
        };
  });
}

export interface CreatePersistenceOptions {
  cipher: RecordCipher;
  /** Underlying localStorage; defaults to `defaultStorage()` (tests inject a memory one). */
  storage?: KeyValueStorage;
  /** IndexedDB database name for message history; matches the signal-cli backend's. */
  dbName?: string;
}

export interface Persistence {
  storage: HydratedKeyValue;
  repository: MessageRepository;
}

export async function createPersistence({
  cipher,
  storage = defaultStorage(),
  dbName = DEFAULT_DB_NAME,
}: CreatePersistenceOptions): Promise<Persistence> {
  const [hydrated, repository] = await Promise.all([
    hydrateKeyValue(cipher, storage),
    import('@/core/persistence/IdbMessageRepository').then(({ IdbMessageRepository }) =>
      IdbMessageRepository.open(dbName, cipher),
    ),
  ]);
  return { storage: hydrated, repository };
}
