/**
 * Identity `RecordCipher` for the browser, dev mode, the demo backend and
 * tests, where there's no Tauri vault to key from (docs/ENCRYPTION.md, "Web
 * cache"). Bytes pass through unchanged and `blindId` is the id itself:
 * there's no key to protect anything with, so the cache stays exactly as
 * readable as an unencrypted one — never silently "half" encrypted.
 */
import type { RecordCipher } from './RecordCipher';

export function plaintextCipher(): RecordCipher {
  return {
    encrypt(plain) {
      return Promise.resolve(plain);
    },
    decrypt(ciphertext) {
      return Promise.resolve(ciphertext);
    },
    blindId(id) {
      return Promise.resolve(id);
    },
  };
}
