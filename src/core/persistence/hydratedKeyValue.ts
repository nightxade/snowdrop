/**
 * Encrypted localStorage (docs/ENCRYPTION.md, "Web cache").
 *
 * localStorage's API is synchronous but a `RecordCipher` is async (WebCrypto
 * never blocks). So `hydrateKeyValue` runs once, after unlock: it decrypts
 * every existing value into an in-memory map. After that, `getItem` reads
 * straight from the map (synchronous, as the stores expect) and `setItem`
 * writes the map immediately and queues the encrypted write to the
 * underlying storage; a tiny queue keeps those writes landing in call order
 * even though each one has to await the cipher.
 *
 * A small, explicit allow-list stays in plaintext and bypasses the map
 * entirely: appearance settings the setup/unlock screens want to render
 * themselves correctly before the vault is open. Everything else — including
 * a value that predates encryption — is migrated to the encrypted format the
 * first time it's read here.
 */
import { createLogger } from '@/core/lib';
import { fromBase64, toBase64, utf8Decode, utf8Encode } from './crypto/bytes';
import type { RecordCipher } from './crypto/RecordCipher';
import { defaultStorage, type KeyValueStorage } from './keyValue';

const log = createLogger('storage');

/**
 * A tiny plaintext mirror of `{ themeId, density }`, kept in sync by a
 * dedicated subscription in `createSnowdrop` (see `src/app/createSnowdrop.ts`).
 * Needed before unlock, so the setup/unlock screens can paint themselves in
 * the user's theme without a flash of the wrong one.
 */
export const APPEARANCE_BOOT_KEY = 'snowdrop.appearance.boot';

/** Marks a value as sealed by a {@link RecordCipher}, so legacy plaintext is never mistaken for ciphertext. */
const SEALED_PREFIX = 'sd1:';

/** True for a value written by {@link hydrateKeyValue} (ciphertext), false for legacy plaintext. */
export const isSealedValue = (raw: string): boolean => raw.startsWith(SEALED_PREFIX);

export const BOOTSTRAP_ALLOW_LIST: ReadonlySet<string> = new Set([APPEARANCE_BOOT_KEY]);

export interface HydratedKeyValue extends KeyValueStorage {
  /** Resolves once every write queued so far has reached the underlying storage. */
  flush(): Promise<void>;
}

export async function hydrateKeyValue(
  cipher: RecordCipher,
  underlying: KeyValueStorage = defaultStorage(),
  allowList: ReadonlySet<string> = BOOTSTRAP_ALLOW_LIST,
): Promise<HydratedKeyValue> {
  const memory = new Map<string, string>();
  const toMigrate: string[] = [];

  for (const key of underlying.keys?.() ?? []) {
    if (allowList.has(key)) continue;
    const raw = underlying.getItem(key);
    if (raw === null) continue;
    if (!isSealedValue(raw)) {
      // Written before encryption existed: keep the value and re-encrypt it
      // below.
      memory.set(key, raw);
      toMigrate.push(key);
      continue;
    }
    try {
      const plain = await cipher.decrypt(fromBase64(raw.slice(SEALED_PREFIX.length)), key);
      memory.set(key, utf8Decode(plain));
    } catch {
      // Sealed, but not by this key (e.g. left over from erased data) or
      // tampered with: unreadable, so drop it rather than feed ciphertext to
      // the stores as if it were a setting.
      log.warn('dropped an unreadable encrypted value');
      underlying.removeItem(key);
    }
  }

  // Serialises writes so the underlying storage sees them in call order,
  // even though each write awaits the cipher.
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch((error: unknown) => {
      log.warn('could not persist to encrypted storage', error);
    });
  };
  const writeThrough = (key: string, value: string): void => {
    enqueue(async () => {
      const ciphertext = await cipher.encrypt(utf8Encode(value), key);
      underlying.setItem(key, SEALED_PREFIX + toBase64(ciphertext));
    });
  };

  for (const key of toMigrate) writeThrough(key, memory.get(key) as string);

  return {
    getItem(key) {
      if (allowList.has(key)) return underlying.getItem(key);
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      if (allowList.has(key)) {
        underlying.setItem(key, value);
        return;
      }
      memory.set(key, value);
      writeThrough(key, value);
    },
    removeItem(key) {
      if (allowList.has(key)) {
        underlying.removeItem(key);
        return;
      }
      memory.delete(key);
      enqueue(() => {
        underlying.removeItem(key);
        return Promise.resolve();
      });
    },
    keys() {
      const allowed = [...allowList].filter((key) => underlying.getItem(key) !== null);
      return [...memory.keys(), ...allowed];
    },
    flush() {
      return queue;
    },
  };
}
