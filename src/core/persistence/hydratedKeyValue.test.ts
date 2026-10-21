import { describe, expect, it } from 'vitest';
import { toBase64, utf8Encode } from './crypto/bytes';
import { plaintextCipher } from './crypto/plaintextCipher';
import { webCryptoCipher } from './crypto/webCryptoCipher';
import { BOOTSTRAP_ALLOW_LIST, hydrateKeyValue } from './hydratedKeyValue';
import {
  createMemoryStorage,
  saveVersioned,
  loadVersioned,
  isRecord,
  type VersionedSchema,
} from './keyValue';

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const schema: VersionedSchema<{ name: string }> = {
  key: 'snowdrop.settings',
  version: 1,
  defaults: () => ({ name: 'default' }),
  parse: (data) => (isRecord(data) && typeof data.name === 'string' ? { name: data.name } : null),
};

describe('hydrateKeyValue', () => {
  it('serves reads from memory after hydration and write-throughs encrypted', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const underlying = createMemoryStorage();
    const storage = await hydrateKeyValue(cipher, underlying);

    saveVersioned(storage, schema, { name: 'alice' });
    // Synchronous read, served from memory straight away.
    expect(loadVersioned(storage, schema)).toEqual({ name: 'alice' });

    await storage.flush();
    // The underlying storage holds ciphertext, not the plaintext JSON, under a blinded name.
    expect(underlying.getItem(schema.key)).toBeNull();
    const stored = underlying.keys?.() ?? [];
    expect(stored).toHaveLength(1);
    const raw = underlying.getItem(stored[0] as string) as string;
    expect(raw.startsWith('sd2:')).toBe(true);
    expect(raw).not.toContain('alice');
    // A second hydration from the now-encrypted underlying storage reads the same value back.
    const rehydrated = await hydrateKeyValue(cipher, underlying);
    expect(loadVersioned(rehydrated, schema)).toEqual({ name: 'alice' });
  });

  it('drops values sealed by a different key instead of treating them as plaintext', async () => {
    const underlying = createMemoryStorage();
    const old = await hydrateKeyValue(await webCryptoCipher(randomKey()), underlying);
    saveVersioned(old, schema, { name: 'alice' });
    await old.flush();

    const storage = await hydrateKeyValue(await webCryptoCipher(randomKey()), underlying);
    expect(storage.getItem(schema.key)).toBeNull();
    expect(underlying.getItem(schema.key)).toBeNull();
    expect(loadVersioned(storage, schema)).toEqual({ name: 'default' });
  });

  it('writes land on the underlying storage in call order', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const underlying = createMemoryStorage();
    const storage = await hydrateKeyValue(cipher, underlying);

    storage.setItem('k', 'one');
    storage.setItem('k', 'two');
    storage.setItem('k', 'three');
    expect(storage.getItem('k')).toBe('three');

    await storage.flush();
    const rehydrated = await hydrateKeyValue(cipher, underlying);
    expect(rehydrated.getItem('k')).toBe('three');
  });

  it('migrates a pre-encryption plaintext value on first hydrate', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const underlying = createMemoryStorage({
      [schema.key]: JSON.stringify({ v: 1, data: { name: 'legacy' } }),
    });
    const storage = await hydrateKeyValue(cipher, underlying);
    expect(loadVersioned(storage, schema)).toEqual({ name: 'legacy' });

    await storage.flush();
    // The readable name is gone; the value now lives, as ciphertext, under a blinded one.
    expect(underlying.getItem(schema.key)).toBeNull();
    const [stored] = underlying.keys?.() ?? [];
    expect(underlying.getItem(stored as string)).not.toContain('legacy');

    // And a fresh hydrate decrypts it straight away (no more migration needed).
    const rehydrated = await hydrateKeyValue(cipher, underlying);
    expect(loadVersioned(rehydrated, schema)).toEqual({ name: 'legacy' });
  });

  it('migrates pre-encryption values under plaintextCipher too (normalises the format)', async () => {
    const cipher = plaintextCipher();
    const underlying = createMemoryStorage({ test: JSON.stringify({ v: 1, data: { name: 'x' } }) });
    const storage = await hydrateKeyValue(cipher, underlying);
    expect(storage.getItem('test')).toBe(JSON.stringify({ v: 1, data: { name: 'x' } }));
    await storage.flush();
    // Re-encoded (sealed-prefix + base64) even though the cipher is identity.
    expect(underlying.getItem('test')).toBeNull();
    const [stored] = underlying.keys?.() ?? [];
    expect(underlying.getItem(stored as string)).toBe(
      'sd2:' +
        toBase64(
          utf8Encode(
            JSON.stringify({ k: 'test', v: JSON.stringify({ v: 1, data: { name: 'x' } }) }),
          ),
        ),
    );
  });

  it('keeps the bootstrap allow-list in plaintext, unhydrated and untouched', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const bootKey = [...BOOTSTRAP_ALLOW_LIST][0] as string;
    const underlying = createMemoryStorage({ [bootKey]: 'plain-value' });
    const storage = await hydrateKeyValue(cipher, underlying);

    // Read before any write: comes straight from the underlying storage, no decryption.
    expect(storage.getItem(bootKey)).toBe('plain-value');

    storage.setItem(bootKey, 'theme:dusk');
    expect(underlying.getItem(bootKey)).toBe('theme:dusk'); // written straight through, synchronously
    await storage.flush();
    expect(underlying.getItem(bootKey)).toBe('theme:dusk');
  });

  it('removeItem clears both the memory and the underlying value', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const underlying = createMemoryStorage();
    const storage = await hydrateKeyValue(cipher, underlying);
    storage.setItem('k', 'v');
    await storage.flush();
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
    await storage.flush();
    expect(underlying.keys?.()).toEqual([]);
  });

  describe('blinded key names', () => {
    const account = '+15551234567';
    const aci = '0a1b2c3d-1111-2222-3333-444455556666';
    const names = [
      `snowdrop.signal-cli.peers.${account}`,
      `snowdrop.signal-cli.cursor.signal-cli:${account}.${aci}`,
      `snowdrop.local:signal-cli:${account}`,
    ];

    it('never writes an account or any key name to the underlying storage', async () => {
      const cipher = await webCryptoCipher(randomKey());
      const underlying = createMemoryStorage();
      const storage = await hydrateKeyValue(cipher, underlying);
      for (const name of names) storage.setItem(name, `value for ${name}`);
      await storage.flush();

      const stored = underlying.keys?.() ?? [];
      expect(stored).toHaveLength(names.length);
      for (const key of stored) {
        expect(key.startsWith('sk1.')).toBe(true);
        expect(key).not.toContain('snowdrop');
        expect(key).not.toContain('15551234567');
        expect(key).not.toContain(aci);
        const raw = underlying.getItem(key) as string;
        expect(raw).not.toContain('15551234567');
        expect(raw).not.toContain('value for');
      }
      // The same names and values come back after a restart.
      const rehydrated = await hydrateKeyValue(cipher, underlying);
      expect([...(rehydrated.keys?.() ?? [])].sort()).toEqual([...names].sort());
      for (const name of names) expect(rehydrated.getItem(name)).toBe(`value for ${name}`);
    });

    it('moves values stored under readable names (plaintext and sd1) to blinded ones, losing none', async () => {
      const cipher = await webCryptoCipher(randomKey());
      const sealedV1 =
        'sd1:' + toBase64(await cipher.encrypt(utf8Encode('sealed-value'), names[1] as string));
      const underlying = createMemoryStorage({
        [names[0] as string]: 'plain-value',
        [names[1] as string]: sealedV1,
        [names[2] as string]: 'sd1:' + 'AAAA', // sealed by some other key: unreadable, dropped
      });
      const storage = await hydrateKeyValue(cipher, underlying);
      expect(storage.getItem(names[0] as string)).toBe('plain-value');
      expect(storage.getItem(names[1] as string)).toBe('sealed-value');
      expect(storage.getItem(names[2] as string)).toBeNull();
      await storage.flush();

      expect([...(underlying.keys?.() ?? [])].every((k) => k.startsWith('sk1.'))).toBe(true);
      for (const name of names) expect(underlying.getItem(name)).toBeNull();
      const rehydrated = await hydrateKeyValue(cipher, underlying);
      expect(rehydrated.getItem(names[0] as string)).toBe('plain-value');
      expect(rehydrated.getItem(names[1] as string)).toBe('sealed-value');
    });

    it('prefers the blinded copy when an interrupted migration left both', async () => {
      const cipher = await webCryptoCipher(randomKey());
      const underlying = createMemoryStorage();
      const first = await hydrateKeyValue(cipher, underlying);
      first.setItem(names[0] as string, 'newer');
      await first.flush();
      underlying.setItem(names[0] as string, 'older-plaintext');

      const storage = await hydrateKeyValue(cipher, underlying);
      expect(storage.getItem(names[0] as string)).toBe('newer');
      await storage.flush();
      expect(underlying.getItem(names[0] as string)).toBeNull();
    });

    it('drops a blinded entry sealed under another key', async () => {
      const underlying = createMemoryStorage();
      const old = await hydrateKeyValue(await webCryptoCipher(randomKey()), underlying);
      old.setItem(names[0] as string, 'v');
      await old.flush();
      const storage = await hydrateKeyValue(await webCryptoCipher(randomKey()), underlying);
      expect(storage.keys?.()).toEqual([]);
      expect(underlying.keys?.()).toEqual([]);
    });
  });
});
