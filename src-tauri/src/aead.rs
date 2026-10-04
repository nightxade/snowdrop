//! XChaCha20-Poly1305 sealing and the 32-byte key type the storage layer is
//! built from (see docs/ENCRYPTION.md, "Key hierarchy"). Everything above
//! this module — the keyring slot, later the recovery/passphrase slots, the
//! vault and the web cache key — wraps or derives keys through here rather
//! than touching an AEAD cipher directly.
//!
//! On-disk format of a sealed blob: `[version: u8][nonce: 24 bytes][ciphertext]`.
//! The version byte lets a future format change be rejected loudly instead
//! of misread; today only `0x01` exists.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

const VERSION: u8 = 0x01;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 1 + NONCE_LEN;

/// A 32-byte key — a keyring slot secret, a DEK, or a key derived from one
/// with [`hkdf_subkey`]. Zeroized on drop; `Debug` never prints the bytes.
pub struct Key32([u8; 32]);

impl Key32 {
    /// 32 bytes from the OS random number generator.
    pub fn random() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("the OS random number generator is available");
        Self(bytes)
    }

    /// Wraps an existing 32-byte secret (e.g. one just decoded out of the
    /// keyring). `None` if `bytes` isn't exactly 32 bytes long.
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        <[u8; 32]>::try_from(bytes).ok().map(Self)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Key32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Key32").field(&"<redacted>").finish()
    }
}

impl Drop for Key32 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Derives a subkey from `ikm` with HKDF-SHA256 (no salt, `label` as the
/// HKDF "info"). Distinct labels (e.g. `"snowdrop/vault/v1"`,
/// `"snowdrop/webcache/v1"`) always give distinct, independent keys.
pub fn hkdf_subkey(ikm: &Key32, label: &str) -> Key32 {
    let hk = Hkdf::<Sha256>::new(None, ikm.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(label.as_bytes(), &mut out).expect("32 bytes is a valid HKDF-SHA256 output length");
    Key32(out)
}

/// Seals `plaintext` under `key`, authenticating (but not encrypting) `aad`.
/// Returns `[version][nonce][ciphertext]`; see the module docs.
pub fn seal(key: &Key32, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes).expect("the OS random number generator is available");
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .expect("encryption with a freshly generated nonce never fails");
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

/// Why [`open`] failed. Kept distinct from [`crate::error::Error`]: this
/// module has no IPC surface of its own, and callers that do expose one
/// (`keyslots`, the vault) are better placed to decide what each case means
/// for them (e.g. a tampered blob vs. a format this build predates).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AeadError {
    /// Fewer bytes than a version byte plus a nonce.
    Truncated,
    /// A version byte this build doesn't understand.
    UnknownVersion(u8),
    /// Authentication failed: wrong key, tampered bytes, or mismatched AAD.
    Open,
}

impl fmt::Display for AeadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => write!(f, "sealed data is truncated"),
            Self::UnknownVersion(v) => write!(f, "unknown sealed-data version {v}"),
            Self::Open => {
                write!(f, "decryption failed (wrong key, tampered data, or mismatched associated data)")
            }
        }
    }
}

impl std::error::Error for AeadError {}

/// Opens data sealed by [`seal`] with the same `key` and `aad`.
pub fn open(key: &Key32, data: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, AeadError> {
    let header = data.get(..HEADER_LEN).ok_or(AeadError::Truncated)?;
    let version = header[0];
    if version != VERSION {
        return Err(AeadError::UnknownVersion(version));
    }
    let nonce = XNonce::from_slice(&header[1..]);
    let ciphertext = &data[HEADER_LEN..];
    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    let plaintext = cipher.decrypt(nonce, Payload { msg: ciphertext, aad }).map_err(|_| AeadError::Open)?;
    Ok(Zeroizing::new(plaintext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let key = Key32::random();
        let sealed = seal(&key, b"hello vault", b"aad");
        let opened = open(&key, &sealed, b"aad").unwrap();
        assert_eq!(&opened[..], b"hello vault");
    }

    #[test]
    fn wrong_aad_fails() {
        let key = Key32::random();
        let sealed = seal(&key, b"hello vault", b"aad-one");
        assert_eq!(open(&key, &sealed, b"aad-two").unwrap_err(), AeadError::Open);
    }

    #[test]
    fn tampered_byte_fails() {
        let key = Key32::random();
        let mut sealed = seal(&key, b"hello vault", b"aad");
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(open(&key, &sealed, b"aad").unwrap_err(), AeadError::Open);
    }

    #[test]
    fn truncated_input_fails() {
        let key = Key32::random();
        let sealed = seal(&key, b"hello vault", b"aad");
        for truncate_to in [0, 1, HEADER_LEN - 1] {
            assert_eq!(open(&key, &sealed[..truncate_to], b"aad").unwrap_err(), AeadError::Truncated);
        }
    }

    #[test]
    fn unknown_version_fails() {
        let key = Key32::random();
        let mut sealed = seal(&key, b"hello vault", b"aad");
        sealed[0] = 0x02;
        assert_eq!(open(&key, &sealed, b"aad").unwrap_err(), AeadError::UnknownVersion(0x02));
    }

    #[test]
    fn wrong_key_fails() {
        let sealed = seal(&Key32::random(), b"hello vault", b"aad");
        assert_eq!(open(&Key32::random(), &sealed, b"aad").unwrap_err(), AeadError::Open);
    }

    #[test]
    fn distinct_labels_give_distinct_keys() {
        let ikm = Key32::random();
        let a = hkdf_subkey(&ikm, "snowdrop/vault/v1");
        let b = hkdf_subkey(&ikm, "snowdrop/webcache/v1");
        assert_ne!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn same_label_is_deterministic() {
        let ikm = Key32::random();
        let a = hkdf_subkey(&ikm, "snowdrop/vault/v1");
        let b = hkdf_subkey(&ikm, "snowdrop/vault/v1");
        assert_eq!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn debug_never_prints_the_key() {
        let key = Key32::from_slice(&[0x42; 32]).unwrap();
        assert!(!format!("{key:?}").contains("66")); // 0x42 == 66 decimal
        assert!(format!("{key:?}").contains("redacted"));
    }

    #[test]
    fn from_slice_rejects_the_wrong_length() {
        assert!(Key32::from_slice(&[0u8; 31]).is_none());
        assert!(Key32::from_slice(&[0u8; 33]).is_none());
        assert!(Key32::from_slice(&[0u8; 32]).is_some());
    }
}
