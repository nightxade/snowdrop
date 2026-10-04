import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from './bytes';
import { plaintextCipher } from './plaintextCipher';
import type { RecordCipher } from './RecordCipher';
import { webCryptoCipher } from './webCryptoCipher';

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe('webCryptoCipher', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const plain = utf8Encode('hello, snowdrop');
    const ciphertext = await cipher.encrypt(plain, 'record-1');
    expect(ciphertext).not.toEqual(plain);
    const decrypted = await cipher.decrypt(ciphertext, 'record-1');
    expect(utf8Decode(decrypted)).toBe('hello, snowdrop');
  });

  it('produces a version byte + 12-byte IV + ciphertext, with a fresh IV each time', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const plain = utf8Encode('same plaintext');
    const a = await cipher.encrypt(plain, 'aad');
    const b = await cipher.encrypt(plain, 'aad');
    expect(a[0]).toBe(1);
    expect(a.length).toBe(1 + 12 + plain.length + 16); // +16: AES-GCM auth tag
    expect(a.slice(1, 13)).not.toEqual(b.slice(1, 13)); // IVs differ
    expect(a).not.toEqual(b); // so do ciphertexts
  });

  it('fails to decrypt with the wrong AAD', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const ciphertext = await cipher.encrypt(utf8Encode('secret'), 'conversation-a');
    await expect(cipher.decrypt(ciphertext, 'conversation-b')).rejects.toThrow();
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const ciphertext = await cipher.encrypt(utf8Encode('secret'), 'aad');
    const tampered = new Uint8Array(ciphertext);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    await expect(cipher.decrypt(tampered, 'aad')).rejects.toThrow();
  });

  it('blindId is deterministic for a given key and differs across keys', async () => {
    const key = randomKey();
    const cipherA1 = await webCryptoCipher(key.slice());
    const cipherA2 = await webCryptoCipher(key.slice());
    const cipherB = await webCryptoCipher(randomKey());

    const a1 = await cipherA1.blindId('dm:+15555550123');
    const a2 = await cipherA2.blindId('dm:+15555550123');
    const b = await cipherB.blindId('dm:+15555550123');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    // base64url: no '+', '/' or padding.
    expect(a1).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('blindId differs for different ids under the same key', async () => {
    const cipher = await webCryptoCipher(randomKey());
    expect(await cipher.blindId('a')).not.toBe(await cipher.blindId('b'));
  });

  it('zeroes the raw key bytes after import', async () => {
    const key = randomKey();
    const copy = key.slice();
    await webCryptoCipher(key);
    expect(key.every((b) => b === 0)).toBe(true);
    expect(copy.some((b) => b !== 0)).toBe(true); // sanity: the key wasn't all-zero to begin with
  });

  it('rejects a key of the wrong length', async () => {
    await expect(webCryptoCipher(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('plaintextCipher', () => {
  it('is an identity transform (dev/browser mode, no vault)', async () => {
    const cipher: RecordCipher = plaintextCipher();
    const plain = utf8Encode('not actually secret');
    const ciphertext = await cipher.encrypt(plain, 'aad');
    expect(ciphertext).toEqual(plain);
    expect(await cipher.decrypt(ciphertext, 'whatever-aad')).toEqual(plain);
    expect(await cipher.blindId('dm:+15555550123')).toBe('dm:+15555550123');
  });
});
