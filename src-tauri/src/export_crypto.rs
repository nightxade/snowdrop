//! Passphrase-encrypted history exports (Settings → Data & storage →
//! Export history; docs/ENCRYPTION.md, "Encrypted history export").
//!
//! The same primitives as the passphrase keyslot — Argon2id for the key,
//! XChaCha20-Poly1305 (via [`aead`]) for the data — around a small,
//! versioned header, so the file can be read back by anything that follows
//! the layout below.
//!
//! ```text
//! offset  size  field
//!      0     4  magic "SDEX"
//!      4     1  format version (1)
//!      5     1  key derivation (1 = Argon2id)
//!      6     4  Argon2id memory in KiB, little endian
//!     10     4  Argon2id passes, little endian
//!     14     4  Argon2id lanes, little endian
//!     18    16  salt
//!     34     …  aead::seal output: [0x01][24-byte nonce][ciphertext + tag]
//! ```
//!
//! The whole 34-byte header is the AEAD's associated data, so changing a
//! parameter (to weaken the KDF, say) fails authentication instead of
//! silently decrypting with different settings.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use zeroize::Zeroizing;

use crate::aead;
use crate::error::{Error, ErrorKind};
use crate::keyslots::{check_new_passphrase, derive_kek, new_kdf_params, KdfAlg, KdfParams, PASSPHRASE_KDF};

const MAGIC: &[u8; 4] = b"SDEX";
const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const SALT_LEN: usize = 16;
const HEADER_LEN: usize = 4 + 1 + 1 + 4 + 4 + 4 + SALT_LEN;
const AAD_DOMAIN: &[u8] = b"snowdrop/export/v1";

fn header_bytes(kdf: &KdfParams) -> Result<Vec<u8>, Error> {
    let salt = STANDARD
        .decode(&kdf.salt)
        .map_err(|_| Error::new(ErrorKind::Internal, "Export salt isn't valid base64."))?;
    if salt.len() != SALT_LEN {
        return Err(Error::new(ErrorKind::Internal, "Export salt has the wrong length."));
    }
    let mut out = Vec::with_capacity(HEADER_LEN);
    out.extend_from_slice(MAGIC);
    out.push(FORMAT_VERSION);
    out.push(KDF_ARGON2ID);
    out.extend_from_slice(&kdf.m_kib.to_le_bytes());
    out.extend_from_slice(&kdf.t.to_le_bytes());
    out.extend_from_slice(&kdf.p.to_le_bytes());
    out.extend_from_slice(&salt);
    Ok(out)
}

fn aad(header: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(AAD_DOMAIN.len() + header.len());
    out.extend_from_slice(AAD_DOMAIN);
    out.extend_from_slice(header);
    out
}

/// Encrypts `plaintext` under a key derived from `passphrase`. The passphrase
/// must meet the same minimum as a new keyslot passphrase (8 characters).
pub fn seal_export(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    check_new_passphrase(passphrase)?;
    let kdf = new_kdf_params(PASSPHRASE_KDF)?;
    let key = derive_kek(passphrase.as_bytes(), &kdf)?;
    let mut out = header_bytes(&kdf)?;
    let sealed = aead::seal(&key, plaintext, &aad(&out));
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// The inverse of [`seal_export`]. A wrong passphrase, a modified file and a
/// modified header all fail the same way (`AuthFailed`); a file that isn't
/// one of these exports, or is from a newer format, is `Config`.
///
/// Snowdrop has no import for history exports, so nothing in the app calls
/// this yet; it keeps the format honest (tests) and documents the reader.
#[cfg_attr(not(test), allow(dead_code))]
pub fn open_export(passphrase: &str, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let header = data.get(..HEADER_LEN).filter(|h| h.starts_with(MAGIC)).ok_or_else(|| {
        Error::new(ErrorKind::Config, "This file isn't a Snowdrop history export.")
    })?;
    if header[4] != FORMAT_VERSION || header[5] != KDF_ARGON2ID {
        return Err(Error::new(ErrorKind::Config, "This export was made by a newer version of Snowdrop."));
    }
    let word = |at: usize| u32::from_le_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]]);
    let kdf = KdfParams {
        alg: KdfAlg::Argon2id,
        m_kib: word(6),
        t: word(10),
        p: word(14),
        salt: STANDARD.encode(&header[18..18 + SALT_LEN]),
    };
    let key = derive_kek(passphrase.as_bytes(), &kdf)?;
    aead::open(&key, &data[HEADER_LEN..], &aad(header))
        .map_err(|_| Error::new(ErrorKind::AuthFailed, "Wrong passphrase, or the file was modified."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_a_versioned_header() {
        let sealed = seal_export("correct horse", b"{\"messages\":[]}").unwrap();
        assert_eq!(&sealed[..4], b"SDEX");
        assert_eq!(sealed[4], 1);
        assert_eq!(sealed[5], 1);
        assert!(!sealed.windows(8).any(|w| w == b"messages"));
        assert_eq!(&open_export("correct horse", &sealed).unwrap()[..], b"{\"messages\":[]}");
    }

    #[test]
    fn wrong_passphrase_fails() {
        let sealed = seal_export("correct horse", b"secret").unwrap();
        let err = open_export("battery staple", &sealed).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn short_passphrase_is_refused() {
        assert_eq!(seal_export("short", b"x").unwrap_err().kind, ErrorKind::Config);
    }

    #[test]
    fn each_export_gets_a_fresh_salt_and_nonce() {
        let a = seal_export("correct horse", b"same").unwrap();
        let b = seal_export("correct horse", b"same").unwrap();
        assert_ne!(a[18..34], b[18..34]);
        assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
    }

    #[test]
    fn tampering_with_the_header_or_body_fails() {
        let sealed = seal_export("correct horse", b"secret").unwrap();
        // Weakening the KDF cost changes the AAD and the derived key.
        let mut weaker = sealed.clone();
        weaker[10] = 2;
        assert!(open_export("correct horse", &weaker).is_err());
        let mut body = sealed.clone();
        let last = body.len() - 1;
        body[last] ^= 1;
        assert_eq!(open_export("correct horse", &body).unwrap_err().kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn rejects_other_files_and_newer_versions() {
        assert_eq!(open_export("correct horse", b"not an export at all, just text....").unwrap_err().kind, ErrorKind::Config);
        let mut sealed = seal_export("correct horse", b"secret").unwrap();
        sealed[4] = 2;
        assert_eq!(open_export("correct horse", &sealed).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(open_export("correct horse", &sealed[..10]).unwrap_err().kind, ErrorKind::Config);
    }
}
