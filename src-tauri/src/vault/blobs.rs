//! Blob storage: `vault/blobs/<32 hex chars>`, one sealed file per tracked
//! path, each under its own random id (docs/ENCRYPTION.md, "signal-cli
//! vault"). AAD: `"snowdrop/vault/blob/v1" || vault_id || blob_id`, so a
//! blob's ciphertext authenticates only at its own id and in its own vault —
//! swapped or replayed elsewhere, it simply fails to open.
//!
//! A blob is written once and never overwritten: `sync` always picks a
//! fresh id for a changed file, which is what lets `manifest.prev` go on
//! pointing at the old content until [`gc`] catches up.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::aead::{self, Key32};
use crate::error::{Error, ErrorKind};

use super::{blobs_dir, from_hex, io_err, to_hex, write_secure_file, BLOB_ID_LEN, VAULT_ID_LEN};

const AAD_DOMAIN: &[u8] = b"snowdrop/vault/blob/v1";

pub(crate) type BlobId = [u8; BLOB_ID_LEN];

fn random_id() -> Result<BlobId, Error> {
    let mut id = [0u8; BLOB_ID_LEN];
    getrandom::getrandom(&mut id).map_err(|e| Error::new(ErrorKind::Internal, format!("vault: RNG failure: {e}")))?;
    Ok(id)
}

pub(crate) fn id_to_hex(id: &BlobId) -> String {
    to_hex(id)
}

pub(crate) fn id_from_hex(s: &str) -> Option<BlobId> {
    BlobId::try_from(from_hex(s)?).ok()
}

fn path(vault_dir: &Path, id: &BlobId) -> PathBuf {
    blobs_dir(vault_dir).join(id_to_hex(id))
}

fn aad(vault_id: &[u8; VAULT_ID_LEN], id: &BlobId) -> Vec<u8> {
    let mut out = Vec::with_capacity(AAD_DOMAIN.len() + VAULT_ID_LEN + BLOB_ID_LEN);
    out.extend_from_slice(AAD_DOMAIN);
    out.extend_from_slice(vault_id);
    out.extend_from_slice(id);
    out
}

/// Seals `plaintext` into a brand new blob under a fresh random id, fsyncs
/// it, and returns the id. Never overwrites an existing blob.
pub(crate) fn write(vault_dir: &Path, key: &Key32, vault_id: &[u8; VAULT_ID_LEN], plaintext: &[u8]) -> Result<BlobId, Error> {
    let id = random_id()?;
    let sealed = aead::seal(key, plaintext, &aad(vault_id, &id));
    write_secure_file(&path(vault_dir, &id), &sealed)?;
    Ok(id)
}

/// Reads and opens blob `id`. [`ErrorKind::VaultBlobCorrupt`] covers a
/// missing file, a tampered one, and one whose ciphertext was swapped from a
/// different id or a different vault — the AAD binds both, and restore
/// can't (and shouldn't) tell those cases apart.
pub(crate) fn read(vault_dir: &Path, key: &Key32, vault_id: &[u8; VAULT_ID_LEN], id: &BlobId) -> Result<Vec<u8>, Error> {
    let p = path(vault_dir, id);
    let sealed = fs::read(&p).map_err(|_| Error::new(ErrorKind::VaultBlobCorrupt, format!("vault: blob {} is missing.", id_to_hex(id))))?;
    aead::open(key, &sealed, &aad(vault_id, id))
        .map(|z| z.to_vec())
        .map_err(|_| Error::new(ErrorKind::VaultBlobCorrupt, format!("vault: blob {} failed to decrypt.", id_to_hex(id))))
}

/// Deletes every file under `blobs/` whose name isn't a blob id in `keep` —
/// that covers both genuinely unreferenced blobs and any stray filename that
/// isn't a valid hex id at all. Returns how many files were removed.
pub(crate) fn gc(vault_dir: &Path, keep: &HashSet<BlobId>) -> Result<usize, Error> {
    let dir = blobs_dir(vault_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(io_err(&dir, e)),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| io_err(&dir, e))?;
        let name = entry.file_name();
        let keep_this = name.to_str().and_then(id_from_hex).is_some_and(|id| keep.contains(&id));
        if !keep_this {
            fs::remove_file(entry.path()).map_err(|e| io_err(&entry.path(), e))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-vault-blobs-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("blobs")).unwrap();
        dir
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = temp_dir("round-trip");
        let key = Key32::random();
        let vault_id = [1u8; VAULT_ID_LEN];
        let id = write(&dir, &key, &vault_id, b"hello blob").unwrap();
        assert_eq!(read(&dir, &key, &vault_id, &id).unwrap(), b"hello blob");
    }

    #[test]
    fn wrong_vault_id_fails_to_open() {
        let dir = temp_dir("wrong-id");
        let key = Key32::random();
        let id = write(&dir, &key, &[1u8; VAULT_ID_LEN], b"data").unwrap();
        let err = read(&dir, &key, &[2u8; VAULT_ID_LEN], &id).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultBlobCorrupt);
    }

    #[test]
    fn missing_blob_is_vault_blob_corrupt() {
        let dir = temp_dir("missing");
        let key = Key32::random();
        let err = read(&dir, &key, &[1u8; VAULT_ID_LEN], &[0u8; BLOB_ID_LEN]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultBlobCorrupt);
    }

    #[test]
    fn gc_removes_unreferenced_blobs_and_stray_files() {
        let dir = temp_dir("gc");
        let key = Key32::random();
        let vault_id = [1u8; VAULT_ID_LEN];
        let keep_id = write(&dir, &key, &vault_id, b"keep me").unwrap();
        let drop_id = write(&dir, &key, &vault_id, b"drop me").unwrap();
        fs::write(blobs_dir(&dir).join("not-a-hex-id.tmp"), b"stray").unwrap();

        let mut keep = HashSet::new();
        keep.insert(keep_id);
        let removed = gc(&dir, &keep).unwrap();
        assert_eq!(removed, 2); // drop_id's blob + the stray file

        assert!(path(&dir, &keep_id).exists());
        assert!(!path(&dir, &drop_id).exists());
    }

    #[test]
    fn id_hex_round_trips() {
        let id: BlobId = [0xAB; BLOB_ID_LEN];
        let hex = id_to_hex(&id);
        assert_eq!(id_from_hex(&hex).unwrap(), id);
        assert!(id_from_hex("too-short").is_none());
    }
}
