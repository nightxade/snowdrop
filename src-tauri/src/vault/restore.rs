//! Vault → runtime restore (docs/ENCRYPTION.md, "Restore"): decrypt the
//! manifest (falling back to `manifest.prev`), write every entry the caller's
//! filter accepts into the runtime dir, verify each one's hash, and set its
//! mtime back to what the manifest recorded.

use sha2::{Digest, Sha256};
use std::path::Path;

use crate::error::{Error, ErrorKind};

use super::manifest::{self, ManifestSource};
use super::{blobs, create_secure_dir, to_hex, validate_relpath, write_secure_file, Vault};

/// What a [`Vault::restore`] did.
#[derive(Debug, Clone)]
pub struct RestoreReport {
    /// Which manifest generation was used — [`ManifestSource::Empty`] for a
    /// vault that's never been synced.
    pub source: ManifestSource,
    /// How many entries `filter` accepted and were written.
    pub restored: usize,
}

pub(crate) fn restore(vault: &Vault, runtime_dir: &Path, filter: impl Fn(&str) -> bool) -> Result<RestoreReport, Error> {
    let (manifest, source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
    create_secure_dir(runtime_dir)?;

    let mut restored = 0usize;
    for (relpath, entry) in &manifest.entries {
        validate_relpath(relpath)?;
        if !filter(relpath) {
            continue;
        }
        let id = blobs::id_from_hex(&entry.blob)
            .ok_or_else(|| Error::new(ErrorKind::VaultCorrupt, format!("vault: manifest entry {relpath:?} has a malformed blob id.")))?;
        let plaintext = blobs::read(&vault.dir, &vault.key, &vault.vault_id, &id)?;

        let actual_sha256 = to_hex(&Sha256::digest(&plaintext));
        if actual_sha256 != entry.sha256 {
            return Err(Error::new(ErrorKind::VaultBlobCorrupt, format!("vault: blob for {relpath:?} doesn't match its recorded hash.")));
        }

        let dest = runtime_dir.join(relpath);
        if let Some(parent) = dest.parent() {
            if parent != runtime_dir {
                create_secure_dir(parent)?;
            }
        }
        write_secure_file(&dest, &plaintext)?;
        set_mtime(&dest, entry.mtime_ns)?;
        restored += 1;
    }
    Ok(RestoreReport { source, restored })
}

#[cfg(unix)]
fn set_mtime(path: &Path, mtime_ns: u64) -> Result<(), Error> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| Error::new(ErrorKind::Internal, format!("vault: bad path: {e}")))?;
    let times = [
        libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
        libc::timespec { tv_sec: (mtime_ns / 1_000_000_000) as libc::time_t, tv_nsec: (mtime_ns % 1_000_000_000) as i64 },
    ];
    let rc = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) };
    if rc != 0 {
        return Err(super::io_err(path, std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_mtime(_path: &Path, _mtime_ns: u64) -> Result<(), Error> {
    Ok(())
}

/// Reads a file's mtime back as nanoseconds since the epoch, the same units
/// a manifest entry stores it in — used by tests to confirm [`set_mtime`]
/// round-trips.
#[cfg(test)]
pub(crate) fn mtime_ns(path: &Path) -> u64 {
    use std::time::{Duration, SystemTime};
    let modified = std::fs::metadata(path).unwrap().modified().unwrap();
    modified.duration_since(SystemTime::UNIX_EPOCH).unwrap_or(Duration::ZERO).as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn set_mtime_round_trips() {
        let dir = std::env::temp_dir().join(format!("snowdrop-vault-restore-mtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.txt");
        fs::write(&path, b"content").unwrap();

        let target_ns: u64 = 1_700_000_000_123_456_789;
        set_mtime(&path, target_ns).unwrap();
        assert_eq!(mtime_ns(&path), target_ns);
    }
}
