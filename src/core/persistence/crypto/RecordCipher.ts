/**
 * The seam between persistence (IndexedDB, localStorage) and encryption
 * (docs/ENCRYPTION.md, "Web cache"). Callers never touch WebCrypto directly:
 * they hand a record's bytes and an AAD string to `encrypt`/`decrypt`, or an
 * id to `blindId`, and never see a key.
 *
 * `webCryptoCipher` is the real implementation, keyed from the Tauri vault's
 * web cache key. `plaintextCipher` is its identity stand-in for the browser,
 * dev mode and tests, where there's no vault to key from.
 */
export interface RecordCipher {
  /**
   * Encrypts `plain` under AAD `aad`. The AAD binds the ciphertext to where
   * it's stored (a record id, a storage key, a conversation id) so it can't
   * be moved to another location and decrypted there.
   */
  encrypt(plain: Uint8Array, aad: string): Promise<Uint8Array>;
  /** The inverse of `encrypt`; rejects if `aad` doesn't match or the bytes were tampered with. */
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
  /**
   * A deterministic, one-way id for indexing without storing the plaintext
   * (conversation ids, message ids, mention/contact ids). Same input, same
   * key → same output; different keys → different output.
   */
  blindId(id: string): Promise<string>;
}
