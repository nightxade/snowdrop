import { describe, expect, it } from 'vitest';
import { toBase64, utf8Encode } from './crypto/bytes';
import { plaintextCipher } from './crypto/plaintextCipher';
import { webCryptoCipher } from './crypto/webCryptoCipher';
import { BOOTSTRAP_ALLOW_LIST, hydrateKeyValue } from './hydratedKeyValue';
import { createMemoryStorage, saveVersioned, loadVersioned, isRecord, type VersionedSchema } from './keyValue';

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
    // The underlying storage holds ciphertext, not the plaintext JSON.
    const raw = underlying.getItem(schema.key);
    expect(raw).not.toBeNull();
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
    // The underlying value is now ciphertext.
    const raw = underlying.getItem(schema.key) as string;
    expect(raw).not.toContain('legacy');

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
    expect(underlying.getItem('test')).toBe(
      'sd1:' + toBase64(utf8Encode(JSON.stringify({ v: 1, data: { name: 'x' } }))),
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
    expect(underlying.getItem('k')).toBeNull();
  });
});
