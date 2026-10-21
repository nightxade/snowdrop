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

/**
 * Marks a value as sealed by a {@link RecordCipher}, so legacy plaintext is
 * never mistaken for ciphertext. `sd1:` is the first format (the value alone,
 * stored under its own, readable key); `sd2:` seals `{ k, v }` (the key name
 * too) and is stored under a blinded key name, so key names that embed an
 * account (a phone number, an ACI) never reach the disk. `sd1:` is still read,
 * and re-written as `sd2:` the first time it's loaded.
 */
const SEALED_V1 = 'sd1:';
const SEALED_V2 = 'sd2:';

/** Prefix of every blinded storage key name written by this module. */
const BLINDED_KEY_PREFIX = 'sk1.';
/** Domain separation: key names are blinded under the same HMAC key as conversation ids. */
const KEY_BLIND_DOMAIN = 'snowdrop/storage-key/v1\0';

/** True for a value written by {@link hydrateKeyValue} (ciphertext), false for legacy plaintext. */
export const isSealedValue = (raw: string): boolean =>
  raw.startsWith(SEALED_V1) || raw.startsWith(SEALED_V2);

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
  const blindedName = async (key: string): Promise<string> =>
    BLINDED_KEY_PREFIX + (await cipher.blindId(KEY_BLIND_DOMAIN + key));

  const readBlinded = async (stored: string, raw: string): Promise<[string, string] | null> => {
    try {
      const plain = await cipher.decrypt(fromBase64(raw.slice(SEALED_V2.length)), stored);
      const parsed: unknown = JSON.parse(utf8Decode(plain));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { k?: unknown }).k === 'string' &&
        typeof (parsed as { v?: unknown }).v === 'string'
      ) {
        return [(parsed as { k: string }).k, (parsed as { v: string }).v];
      }
    } catch {
      // Falls through: unreadable.
    }
    return null;
  };

  // Names written under the first (readable-name) format, to migrate below.
  const legacyKeys: string[] = [];
  for (const key of underlying.keys?.() ?? []) {
    if (allowList.has(key)) continue;
    const raw = underlying.getItem(key);
    if (raw === null) continue;
    if (key.startsWith(BLINDED_KEY_PREFIX)) {
      const entry = raw.startsWith(SEALED_V2) ? await readBlinded(key, raw) : null;
      if (entry) {
        memory.set(entry[0], entry[1]);
      } else {
        // Sealed, but not by this key (e.g. left over from erased data) or
        // tampered with: unreadable, so drop it rather than feed ciphertext
        // to the stores as if it were a setting.
        log.warn('dropped an unreadable encrypted value');
        underlying.removeItem(key);
      }
      continue;
    }
    legacyKeys.push(key);
  }

  const toMigrate: string[] = [];
  for (const key of legacyKeys) {
    const raw = underlying.getItem(key);
    if (raw === null) continue;
    let value: string | null;
    if (!isSealedValue(raw)) {
      // Written before encryption existed: keep the value and re-encrypt it
      // below.
      value = raw;
    } else if (raw.startsWith(SEALED_V1)) {
      try {
        value = utf8Decode(await cipher.decrypt(fromBase64(raw.slice(SEALED_V1.length)), key));
      } catch {
        log.warn('dropped an unreadable encrypted value');
        underlying.removeItem(key);
        continue;
      }
    } else {
      // `sd2:` under a readable name: not something this code writes.
      underlying.removeItem(key);
      continue;
    }
    if (memory.has(key)) {
      // An interrupted migration left both: the blinded copy is the newer one.
      underlying.removeItem(key);
      continue;
    }
    memory.set(key, value);
    toMigrate.push(key);
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
      const stored = await blindedName(key);
      const ciphertext = await cipher.encrypt(
        utf8Encode(JSON.stringify({ k: key, v: value })),
        stored,
      );
      underlying.setItem(stored, SEALED_V2 + toBase64(ciphertext));
    });
  };

  // Each legacy value is written under its blinded name first and only then
  // removed from the old one, so an interruption between the two loses nothing.
  for (const key of toMigrate) {
    writeThrough(key, memory.get(key) as string);
    enqueue(() => {
      underlying.removeItem(key);
      return Promise.resolve();
    });
  }

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
      enqueue(async () => {
        underlying.removeItem(await blindedName(key));
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
