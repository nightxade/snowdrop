/**
 * The real `RecordCipher`, keyed from the 32-byte web cache key (fetched
 * once over IPC after unlock, see `storage_webcache_key` in
 * src/platform/tauri/desktop.ts; docs/ENCRYPTION.md, "Web cache").
 *
 * HKDF derives two non-extractable sub-keys from it, domain-separated by
 * `info`, so the two uses can't be confused or replayed against each other:
 * AES-GCM-256 for record bodies, HMAC-SHA256 for blind ids. The raw key
 * bytes are imported once and then zeroed; only the derived, non-extractable
 * `CryptoKey`s remain in memory.
 *
 * Wire format of `encrypt`'s output: `[version byte][12-byte IV][ciphertext]`.
 */
import { toBase64Url, utf8Encode } from './bytes';
import type { RecordCipher } from './RecordCipher';

const VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

const AES_INFO = utf8Encode('snowdrop/webcache/aes-gcm/v1');
const HMAC_INFO = utf8Encode('snowdrop/webcache/hmac/v1');

export async function webCryptoCipher(rawKey: Uint8Array): Promise<RecordCipher> {
  if (rawKey.length !== KEY_BYTES) {
    throw new Error(`webCryptoCipher: key must be ${KEY_BYTES} bytes, got ${rawKey.length}`);
  }
  // A fresh, guaranteed-ArrayBuffer-backed copy: `rawKey` itself may come
  // from any BufferSource-ish caller, and it's zeroed (both copies) right
  // after import regardless.
  const keyBytes = new Uint8Array(rawKey);

  const baseKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveKey']);
  const [aesKey, hmacKey] = await Promise.all([
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: AES_INFO },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HMAC_INFO },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    ),
  ]);
  // The raw bytes are no longer needed once imported; drop them from memory.
  rawKey.fill(0);
  keyBytes.fill(0);

  return {
    async encrypt(plain, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: utf8Encode(aad) },
          aesKey,
          new Uint8Array(plain),
        ),
      );
      const out = new Uint8Array(1 + IV_BYTES + ciphertext.length);
      out[0] = VERSION;
      out.set(iv, 1);
      out.set(ciphertext, 1 + IV_BYTES);
      return out;
    },

    async decrypt(ciphertext, aad) {
      if (ciphertext.length < 1 + IV_BYTES || ciphertext[0] !== VERSION) {
        throw new Error('webCryptoCipher: unrecognised record format');
      }
      const iv = ciphertext.slice(1, 1 + IV_BYTES);
      const body = ciphertext.slice(1 + IV_BYTES);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: utf8Encode(aad) },
        aesKey,
        body,
      );
      return new Uint8Array(plain);
    },

    async blindId(id) {
      const signature = await crypto.subtle.sign('HMAC', hmacKey, utf8Encode(id));
      return toBase64Url(new Uint8Array(signature));
    },
  };
}
