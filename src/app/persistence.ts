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
  type HydratedKeyValue,
  type KeyValueStorage,
  type MessageRepository,
  type RecordCipher,
} from '@/core/persistence';

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
  dbName = 'snowdrop-signal-cli',
}: CreatePersistenceOptions): Promise<Persistence> {
  const [hydrated, repository] = await Promise.all([
    hydrateKeyValue(cipher, storage),
    import('@/core/persistence/IdbMessageRepository').then(({ IdbMessageRepository }) =>
      IdbMessageRepository.open(dbName, cipher),
    ),
  ]);
  return { storage: hydrated, repository };
}
