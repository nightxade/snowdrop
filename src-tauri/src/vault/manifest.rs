//! The vault manifest: `{ generation, entries: { relpath: { blob, size,
//! mtime_ns, sha256 } } }` (docs/ENCRYPTION.md, "signal-cli vault"), sealed
//! under AAD `"snowdrop/vault/manifest/v1" || vault_id`. The generation
//! number lives inside the plaintext, not the AAD, since it's exactly the
//! thing a restore needs to read before it knows which file it opened.
//!
//! Two generations ever exist on disk at once — `manifest` and
//! `manifest.prev` — so a crash between writing new blobs and committing the
//! new manifest always leaves at least one fully readable generation behind
//! ([`load_with_fallback`]), and [`commit`] is the only place either file is
//! ever written.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use crate::aead::{self, Key32};
use crate::error::{Error, ErrorKind};

use super::{blobs_dir, fsync_dir, io_err, manifest_path, manifest_prev_path, manifest_tmp_path, write_secure_file, VAULT_ID_LEN};

const AAD_DOMAIN: &[u8] = b"snowdrop/vault/manifest/v1";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub generation: u64,
    pub entries: BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManifestEntry {
    /// Hex-encoded blob id: the file at `vault/blobs/<blob>`.
    pub blob: String,
    pub size: u64,
    pub mtime_ns: u64,
    /// Hex-encoded SHA-256 of the plaintext file contents.
    pub sha256: String,
}

/// Which generation [`load_with_fallback`] ended up using.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestSource {
    Current,
    Previous,
    /// Neither `manifest` nor `manifest.prev` exists: a vault that's never
    /// been synced. A valid, empty restore, not an error.
    Empty,
}

fn aad(vault_id: &[u8; VAULT_ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(AAD_DOMAIN.len() + VAULT_ID_LEN);
    out.extend_from_slice(AAD_DOMAIN);
    out.extend_from_slice(vault_id);
    out
}

fn decode(key: &Key32, vault_id: &[u8; VAULT_ID_LEN], sealed: &[u8]) -> Option<Manifest> {
    let plaintext = aead::open(key, sealed, &aad(vault_id)).ok()?;
    serde_json::from_slice(&plaintext).ok()
}

fn read(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(path, e)),
    }
}

/// Loads the manifest, falling back to `manifest.prev` if the current one is
/// missing, or exists but fails to decrypt or parse. `Err(VaultCorrupt)`
/// only when both are unreadable and at least one of the two files exists;
/// both missing is a valid, empty vault.
pub(crate) fn load_with_fallback(vault_dir: &Path, key: &Key32, vault_id: &[u8; VAULT_ID_LEN]) -> Result<(Manifest, ManifestSource), Error> {
    let current = read(&manifest_path(vault_dir))?;
    if let Some(bytes) = &current {
        if let Some(manifest) = decode(key, vault_id, bytes) {
            return Ok((manifest, ManifestSource::Current));
        }
    }
    let prev = read(&manifest_prev_path(vault_dir))?;
    if let Some(bytes) = &prev {
        if let Some(manifest) = decode(key, vault_id, bytes) {
            return Ok((manifest, ManifestSource::Previous));
        }
    }
    if current.is_none() && prev.is_none() {
        // No manifest but existing blobs means the manifests were lost, not
        // that the vault is new: treating it as empty would let the next
        // sync's GC delete every blob.
        if has_blobs(vault_dir)? {
            return Err(Error::new(ErrorKind::VaultCorrupt, "vault: the manifests are missing but encrypted data remains. Nothing was touched."));
        }
        return Ok((Manifest::default(), ManifestSource::Empty));
    }
    Err(Error::new(ErrorKind::VaultCorrupt, "vault: neither manifest nor manifest.prev could be decrypted. Nothing was touched."))
}

fn has_blobs(vault_dir: &Path) -> Result<bool, Error> {
    let dir = blobs_dir(vault_dir);
    match fs::read_dir(&dir) {
        Ok(mut entries) => Ok(entries.next().is_some()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io_err(&dir, e)),
    }
}

/// Commits `manifest` as the vault's new current generation: write
/// `manifest.tmp`, fsync it, rename the existing `manifest` to
/// `manifest.prev` (if any), rename `manifest.tmp` to `manifest`, then fsync
/// the directory. A crash at any point up to the final fsync leaves either
/// the old generation or the new one fully intact — never a mix.
pub(crate) fn commit(vault_dir: &Path, key: &Key32, vault_id: &[u8; VAULT_ID_LEN], manifest: &Manifest) -> Result<(), Error> {
    let json = serde_json::to_vec(manifest).map_err(|e| Error::new(ErrorKind::Internal, format!("vault: couldn't encode the manifest: {e}")))?;
    let sealed = aead::seal(key, &json, &aad(vault_id));
    let tmp = manifest_tmp_path(vault_dir);
    write_secure_file(&tmp, &sealed)?;

    let current = manifest_path(vault_dir);
    let prev = manifest_prev_path(vault_dir);
    if current.exists() {
        fs::rename(&current, &prev).map_err(|e| io_err(&prev, e))?;
    }
    fs::rename(&tmp, &current).map_err(|e| io_err(&current, e))?;
    fsync_dir(vault_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-vault-manifest-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_manifests_with_remaining_blobs_are_corrupt_not_empty() {
        let dir = temp_dir("missing-with-blobs");
        fs::create_dir_all(blobs_dir(&dir)).unwrap();
        fs::write(blobs_dir(&dir).join("00112233445566778899aabbccddeeff"), b"x").unwrap();
        let err = load_with_fallback(&dir, &Key32::random(), &[1u8; VAULT_ID_LEN]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);
    }

    #[test]
    fn missing_manifests_are_a_valid_empty_vault() {
        let dir = temp_dir("missing");
        let key = Key32::random();
        let (manifest, source) = load_with_fallback(&dir, &key, &[1u8; VAULT_ID_LEN]).unwrap();
        assert_eq!(source, ManifestSource::Empty);
        assert_eq!(manifest.generation, 0);
        assert!(manifest.entries.is_empty());
    }

    #[test]
    fn commit_then_load_round_trips_and_increments_generation() {
        let dir = temp_dir("round-trip");
        let key = Key32::random();
        let vault_id = [2u8; VAULT_ID_LEN];
        let mut entries = BTreeMap::new();
        entries.insert("a.txt".into(), ManifestEntry { blob: "aa".into(), size: 1, mtime_ns: 1, sha256: "bb".into() });
        let manifest = Manifest { generation: 1, entries };
        commit(&dir, &key, &vault_id, &manifest).unwrap();

        let (loaded, source) = load_with_fallback(&dir, &key, &vault_id).unwrap();
        assert_eq!(source, ManifestSource::Current);
        assert_eq!(loaded, manifest);
    }

    #[test]
    fn commit_moves_the_previous_manifest_to_prev() {
        let dir = temp_dir("prev-rotation");
        let key = Key32::random();
        let vault_id = [3u8; VAULT_ID_LEN];
        let gen1 = Manifest { generation: 1, entries: BTreeMap::new() };
        commit(&dir, &key, &vault_id, &gen1).unwrap();
        let gen2 = Manifest { generation: 2, entries: BTreeMap::new() };
        commit(&dir, &key, &vault_id, &gen2).unwrap();

        assert!(manifest_prev_path(&dir).exists());
        let (current, _) = load_with_fallback(&dir, &key, &vault_id).unwrap();
        assert_eq!(current.generation, 2);
    }
}
