//! The signal-cli vault: pure filesystem logic that persists the RAM-backed
//! signal-cli runtime dir as an encrypted blob store (docs/ENCRYPTION.md,
//! "signal-cli vault"). No Tauri commands and no service wiring live here —
//! that's the storage service (task 4), which wires a [`VaultSession`] into
//! the signal-cli process lifecycle. This module knows how to `open` a vault
//! directory, `restore` it into a runtime dir, `sync` a runtime dir back
//! into it, resolve the RAM-backed runtime dir itself (`runtime`), take the
//! single-instance lock (`lock`), and orchestrate restore/sync/recovery plus
//! on-demand media and eviction around all of that (`session`).
//!
//! Layout, all under the vault directory (`dir`, mode `0700`):
//! - `manifest`, `manifest.prev`: sealed, serde-encoded [`manifest::Manifest`]s.
//! - `blobs/<32 hex chars>`: one sealed file per tracked path, each under its
//!   own random id. A blob is written once and never overwritten, so
//!   `manifest.prev` always has something to fall back to.
//!
//! Everything on disk is sealed with [`crate::aead`]; see `manifest.rs` and
//! `blobs.rs` for the exact AAD each uses. The only plaintext that ever
//! touches the vault directory is the transient SQLite backup temp file
//! `copy.rs` creates and deletes on every path, including an error.

mod blobs;
mod copy;
mod lock;
mod manifest;
mod restore;
mod runtime;
mod session;
mod sync;

pub use lock::InstanceLock;
pub use manifest::ManifestSource;
pub use restore::RestoreReport;
pub use runtime::resolve as resolve_runtime_dir;
pub use session::{EvictReport, StartKind, VaultSession, DEFAULT_MEDIA_BUDGET_BYTES, DEFAULT_MEDIA_IDLE, MEDIA_PREFIXES};
pub use sync::{SkippedFile, SyncReport};

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::aead::Key32;
use crate::error::{Error, ErrorKind};

/// Bytes in a vault id (bound into every manifest's AAD; see `keyslots.rs`).
pub const VAULT_ID_LEN: usize = 16;
pub(crate) const BLOB_ID_LEN: usize = 16;

/// signal-cli's own top-level data directories — `PathConfig.createDefault`
/// upstream (AsamK/signal-cli): exactly `data/`, `attachments/`, `avatars/`,
/// `stickers/`, nothing else. [`sync`](sync::sync)/[`restore`](restore::restore)
/// only ever write or read paths under one of these, and
/// [`storage::legacy_signal_cli_dir`](crate::storage) only treats a
/// `<app data>/signal-cli/` folder as signal-cli's own plaintext data if it
/// has a `data/` subdirectory.
///
/// This exists because of a real bug: before it, `signal_cli_install.rs`
/// installed a downloaded signal-cli *binary* at this exact same path
/// (`<app data>/signal-cli/<version>/signal-cli`), which made every install
/// look exactly like legacy signal-cli data. `migrate_legacy` synced the
/// ~370 MB binary into the vault as if it were account data, garbage-
/// collected the *real* account data's now-unreferenced blobs, and deleted
/// the "legacy dir" — taking the just-installed binary with it. Restricting
/// every vault read/write to these four names, rather than trusting
/// "whatever's in the directory", means a stray file next to signal-cli's
/// real data (an installed binary, a leftover from some other bug) is
/// simply never synced, never restored, and never counted as legacy data,
/// no matter what else ends up sharing that directory.
pub(crate) const ALLOWED_TOP_DIRS: &[&str] = &["data", "attachments", "avatars", "stickers"];

/// Whether `relpath`'s top-level component is one of [`ALLOWED_TOP_DIRS`].
pub(crate) fn is_allowlisted(relpath: &str) -> bool {
    Path::new(relpath)
        .components()
        .next()
        .and_then(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .is_some_and(|top| ALLOWED_TOP_DIRS.contains(&top))
}

/// The crash-recovery marker's file name, written directly in the runtime
/// dir by `session::VaultSession::start` (docs/ENCRYPTION.md, "Crash
/// recovery"). Named here, not in `session`, so `sync`'s walk can skip it
/// without a dependency between the two sibling modules — a marker must
/// never end up as a tracked manifest entry.
pub(crate) const MARKER_FILE_NAME: &str = ".restored-from";

/// An open vault directory plus the key that seals everything in it. Cheap
/// to construct; all it does on [`open`](Vault::open) is make sure the
/// directories exist with the right mode.
pub struct Vault {
    dir: PathBuf,
    key: Key32,
    vault_id: [u8; VAULT_ID_LEN],
}

impl Vault {
    /// Opens (creating if needed) the vault at `dir`. Doesn't touch
    /// `manifest`/`manifest.prev`: a vault that's never been synced has
    /// neither, and that's a valid, empty vault (see [`restore`](Vault::restore)).
    pub fn open(dir: &Path, key: Key32, vault_id: [u8; VAULT_ID_LEN]) -> Result<Self, Error> {
        create_secure_dir(dir)?;
        create_secure_dir(&blobs_dir(dir))?;
        Ok(Self { dir: dir.to_path_buf(), key, vault_id })
    }

    /// Decrypts the manifest (falling back to `manifest.prev`) and writes
    /// every entry `filter` accepts into `runtime_dir`. `filter` takes a
    /// manifest relpath and is how a later caller (task 3b) excludes media
    /// from a restore and hydrates it on demand instead.
    pub fn restore(&self, runtime_dir: &Path, filter: impl Fn(&str) -> bool) -> Result<RestoreReport, Error> {
        restore::restore(self, runtime_dir, filter)
    }

    /// Diffs `runtime_dir` against the current manifest, copies every
    /// changed file into a new blob, and commits a new manifest generation.
    /// Writes nothing at all if nothing changed.
    ///
    /// Every manifest entry absent from `runtime_dir` is treated as deleted
    /// — the plain behaviour, right for every caller here (none hydrates
    /// media lazily). [`VaultSession`] is the one caller that can't use
    /// this: it calls [`sync::sync_walked`] directly with a predicate that
    /// also keeps a not-yet-hydrated media relpath (docs/ENCRYPTION.md,
    /// "Sync", "Attachment budget").
    pub fn sync(&self, runtime_dir: &Path) -> Result<SyncReport, Error> {
        sync::sync(self, runtime_dir, |_| false)
    }

    /// The vault directory (for callers that need to place sibling state,
    /// e.g. task 3b's instance lock file, next to it).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Drops any manifest entry outside [`ALLOWED_TOP_DIRS`] and garbage-
    /// collects its now-unreferenced blob immediately (see `sync::
    /// purge_non_allowlisted` for why two manifest generations are committed
    /// rather than one). Called at every [`VaultSession::start`], so a vault
    /// manifest left over from before `ALLOWED_TOP_DIRS` existed — in
    /// particular one referencing an installed signal-cli binary instead of
    /// its data (see [`ALLOWED_TOP_DIRS`]'s docs) — is cleaned up on the very
    /// next unlock rather than waiting on ordinary sync activity. Returns how
    /// many entries were dropped; `0` (and nothing written) if the manifest
    /// was already clean.
    pub fn purge_non_allowlisted(&self) -> Result<usize, Error> {
        sync::purge_non_allowlisted(self)
    }
}

pub(crate) fn blobs_dir(vault_dir: &Path) -> PathBuf {
    vault_dir.join("blobs")
}

pub(crate) fn manifest_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join("manifest")
}

pub(crate) fn manifest_prev_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join("manifest.prev")
}

pub(crate) fn manifest_tmp_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join("manifest.tmp")
}

pub(crate) fn io_err(path: &Path, e: io::Error) -> Error {
    Error::new(ErrorKind::Internal, format!("{}: {e}", path.display()))
}

/// Creates `path` (and parents) if needed, then locks it to its owner
/// (`0700`) either way — matching `config::secure_dir`'s "fix it even if it
/// already existed" behaviour.
#[cfg(unix)]
pub(crate) fn create_secure_dir(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path).map_err(|e| io_err(path, e))?;
    let mut perm = fs::metadata(path).map_err(|e| io_err(path, e))?.permissions();
    perm.set_mode(0o700);
    fs::set_permissions(path, perm).map_err(|e| io_err(path, e))
}

#[cfg(not(unix))]
pub(crate) fn create_secure_dir(path: &Path) -> Result<(), Error> {
    fs::create_dir_all(path).map_err(|e| io_err(path, e))
}

/// Writes `contents` as a brand new file at `path` (mode `0600`) and fsyncs
/// it. Used for manifests and blobs alike; never appends or edits in place.
pub(crate) fn write_secure_file(path: &Path, contents: &[u8]) -> Result<(), Error> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| io_err(path, e))?;
    file.write_all(contents).map_err(|e| io_err(path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = file.metadata().map_err(|e| io_err(path, e))?.permissions();
        perm.set_mode(0o600);
        file.set_permissions(perm).map_err(|e| io_err(path, e))?;
    }
    file.sync_all().map_err(|e| io_err(path, e))?;
    Ok(())
}

/// fsyncs `dir` itself, so a rename just performed inside it survives a crash.
pub(crate) fn fsync_dir(dir: &Path) -> Result<(), Error> {
    fs::File::open(dir).and_then(|f| f.sync_all()).map_err(|e| io_err(dir, e))
}

/// Validates a manifest relpath: non-empty, relative, and made up only of
/// plain (`Normal`) components — no `..`, no `.`, no absolute/root/prefix
/// components. UTF-8 is guaranteed by its being a Rust `String` already.
/// Shared by `sync` (every path it writes into the manifest came from
/// walking a real directory, so this should never fail there) and `restore`
/// (defense in depth against a manifest from a different build, even though
/// it's AEAD-authenticated).
pub(crate) fn validate_relpath(relpath: &str) -> Result<(), Error> {
    let bad = || Error::new(ErrorKind::VaultCorrupt, format!("vault: not a valid relative path: {relpath:?}"));
    if relpath.is_empty() {
        return Err(bad());
    }
    let path = Path::new(relpath);
    if path.is_absolute() {
        return Err(bad());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(bad()),
        }
    }
    Ok(())
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

pub(crate) fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    pub(crate) fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    /// The returned `TempDir` *is* the vault directory itself (not its
    /// parent): `vault.dir()` and the guard's path are the same, so tests
    /// that compare or reuse it don't need any extra indirection.
    pub(crate) fn open_vault(name: &str) -> (Vault, TempDir, Key32, [u8; VAULT_ID_LEN]) {
        let dir = temp_dir(name);
        let key = Key32::random();
        let vault_id = [7u8; VAULT_ID_LEN];
        let vault = Vault::open(dir.path(), Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        (vault, dir, key, vault_id)
    }

    pub(crate) fn write_file(dir: &Path, relpath: &str, contents: &[u8]) {
        let path = dir.join(relpath);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
    }

    pub(crate) fn read_file(dir: &Path, relpath: &str) -> Vec<u8> {
        fs::read(dir.join(relpath)).unwrap()
    }

    fn touch_mtime_forward(path: &Path) {
        // Some filesystems have coarse mtime granularity; nudge the clock
        // forward explicitly so "changed" tests can't flake on a fast box.
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + std::time::Duration::from_secs(2);
        let file = fs::File::open(path).unwrap();
        file.set_modified(UNIX_EPOCH + now).unwrap();
    }

    #[test]
    fn open_creates_secure_directories() {
        let (vault, dir, _key, _id) = open_vault("open-dirs");
        let dir = dir.path();
        assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(blobs_dir(dir)).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(vault.dir(), dir);
    }

    #[test]
    fn empty_vault_restores_to_nothing() {
        let (vault, _dir, _key, _id) = open_vault("empty-restore");
        let runtime = temp_dir("empty-restore-runtime");
        let runtime = runtime.path();
        let report = vault.restore(runtime, |_| true).unwrap();
        assert_eq!(report.restored, 0);
        assert_eq!(report.source, ManifestSource::Empty);
    }

    #[test]
    fn unchanged_sync_writes_nothing() {
        let (vault, dir, _key, _id) = open_vault("unchanged");
        let dir = dir.path();
        let runtime = temp_dir("unchanged-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"hello");

        let first = vault.sync(runtime).unwrap();
        assert!(first.wrote);
        assert_eq!(first.generation, 1);

        let manifest_mtime = fs::metadata(manifest_path(dir)).unwrap().modified().unwrap();
        let second = vault.sync(runtime).unwrap();
        assert!(!second.wrote);
        assert_eq!(second.generation, 1);
        assert_eq!(fs::metadata(manifest_path(dir)).unwrap().modified().unwrap(), manifest_mtime);
    }

    #[test]
    fn round_trip_with_nested_dirs() {
        let (vault, _dir, _key, _id) = open_vault("round-trip");
        let runtime = temp_dir("round-trip-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"top level");
        write_file(runtime, "data/account", b"account data");
        write_file(runtime, "attachments/img/one.jpg", b"fake jpeg bytes");

        let report = vault.sync(runtime).unwrap();
        assert!(report.wrote);
        assert_eq!(report.changed, 3);

        let restored = temp_dir("round-trip-restored");
        let restored = restored.path();
        let r = vault.restore(restored, |_| true).unwrap();
        assert_eq!(r.restored, 3);
        assert_eq!(r.source, ManifestSource::Current);
        assert_eq!(read_file(restored, "data/a.txt"), b"top level");
        assert_eq!(read_file(restored, "data/account"), b"account data");
        assert_eq!(read_file(restored, "attachments/img/one.jpg"), b"fake jpeg bytes");
    }

    #[test]
    fn modify_delete_and_add_files_across_generations() {
        let (vault, _dir, _key, _id) = open_vault("mutate");
        let runtime = temp_dir("mutate-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/keep.txt", b"unchanged forever");
        write_file(runtime, "data/change.txt", b"v1");
        write_file(runtime, "data/remove.txt", b"going away");
        let r1 = vault.sync(runtime).unwrap();
        assert_eq!(r1.generation, 1);

        fs::remove_file(runtime.join("data/remove.txt")).unwrap();
        fs::write(runtime.join("data/change.txt"), b"v2, longer content").unwrap();
        touch_mtime_forward(&runtime.join("data/change.txt"));
        write_file(runtime, "data/added.txt", b"brand new");
        let r2 = vault.sync(runtime).unwrap();
        assert!(r2.wrote);
        assert_eq!(r2.generation, 2);
        assert_eq!(r2.deleted, 1);
        assert_eq!(r2.changed, 2); // change.txt + added.txt

        let restored = temp_dir("mutate-restored");
        let restored = restored.path();
        let report = vault.restore(restored, |_| true).unwrap();
        assert_eq!(report.restored, 3);
        assert_eq!(read_file(restored, "data/keep.txt"), b"unchanged forever");
        assert_eq!(read_file(restored, "data/change.txt"), b"v2, longer content");
        assert_eq!(read_file(restored, "data/added.txt"), b"brand new");
        assert!(!restored.join("data/remove.txt").exists());
    }

    #[test]
    fn manifest_prev_fallback_when_current_is_corrupted() {
        let (vault, dir, _key, _id) = open_vault("prev-fallback");
        let dir = dir.path();
        let runtime = temp_dir("prev-fallback-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"gen1");
        vault.sync(runtime).unwrap();

        fs::write(runtime.join("data/a.txt"), b"gen2, different length").unwrap();
        touch_mtime_forward(&runtime.join("data/a.txt"));
        vault.sync(runtime).unwrap();

        // Corrupt only the current manifest; manifest.prev (gen1) should still work.
        let mut bytes = fs::read(manifest_path(dir)).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        fs::write(manifest_path(dir), bytes).unwrap();

        let restored = temp_dir("prev-fallback-restored");
        let restored = restored.path();
        let report = vault.restore(restored, |_| true).unwrap();
        assert_eq!(report.source, ManifestSource::Previous);
        assert_eq!(read_file(restored, "data/a.txt"), b"gen1");
    }

    #[test]
    fn both_manifests_corrupt_is_vault_corrupt_and_deletes_nothing() {
        let (vault, dir, _key, _id) = open_vault("both-corrupt");
        let dir = dir.path();
        let runtime = temp_dir("both-corrupt-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"gen1");
        vault.sync(runtime).unwrap();
        fs::write(runtime.join("data/a.txt"), b"gen2 content here").unwrap();
        touch_mtime_forward(&runtime.join("data/a.txt"));
        vault.sync(runtime).unwrap();

        fs::write(manifest_path(dir), b"not a sealed manifest").unwrap();
        fs::write(manifest_prev_path(dir), b"also not a sealed manifest").unwrap();

        let blobs_before: Vec<_> = fs::read_dir(blobs_dir(dir)).unwrap().map(|e| e.unwrap().path()).collect();

        let restored = temp_dir("both-corrupt-restored");
        let restored = restored.path();
        let err = vault.restore(restored, |_| true).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);

        let blobs_after: Vec<_> = fs::read_dir(blobs_dir(dir)).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(blobs_before.len(), blobs_after.len(), "nothing should be deleted on VaultCorrupt");
    }

    #[test]
    fn tampered_blob_fails_distinctly() {
        let (vault, dir, _key, _id) = open_vault("tampered-blob");
        let dir = dir.path();
        let runtime = temp_dir("tampered-blob-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"original content");
        vault.sync(runtime).unwrap();

        let blob_path = fs::read_dir(blobs_dir(dir)).unwrap().next().unwrap().unwrap().path();
        let mut bytes = fs::read(&blob_path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        fs::write(&blob_path, bytes).unwrap();

        let restored = temp_dir("tampered-blob-restored");
        let restored = restored.path();
        let err = vault.restore(restored, |_| true).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultBlobCorrupt);
    }

    #[test]
    fn blob_contents_swapped_between_paths_fails_distinctly() {
        let (vault, dir, _key, _id) = open_vault("swapped-blob");
        let dir = dir.path();
        let runtime = temp_dir("swapped-blob-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"content A");
        write_file(runtime, "data/b.txt", b"content B, different size");
        vault.sync(runtime).unwrap();

        let mut blob_paths: Vec<_> = fs::read_dir(blobs_dir(dir)).unwrap().map(|e| e.unwrap().path()).collect();
        blob_paths.sort();
        assert_eq!(blob_paths.len(), 2);
        let a = fs::read(&blob_paths[0]).unwrap();
        let b = fs::read(&blob_paths[1]).unwrap();
        // Swap ciphertexts while keeping filenames (blob ids) as-is: each
        // blob's AAD is bound to its own id, so the swapped content now
        // authenticates against the wrong id and must fail to open.
        fs::write(&blob_paths[0], &b).unwrap();
        fs::write(&blob_paths[1], &a).unwrap();

        let restored = temp_dir("swapped-blob-restored");
        let restored = restored.path();
        let err = vault.restore(restored, |_| true).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultBlobCorrupt);
    }

    #[test]
    fn wrong_vault_id_fails() {
        let (vault, dir, key, _id) = open_vault("wrong-vault-id");
        let dir = dir.path();
        let runtime = temp_dir("wrong-vault-id-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"secret stuff");
        vault.sync(runtime).unwrap();

        let other = Vault::open(dir, key, [9u8; VAULT_ID_LEN]).unwrap();
        let restored = temp_dir("wrong-vault-id-restored");
        let restored = restored.path();
        let err = other.restore(restored, |_| true).unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);
    }

    #[test]
    fn gc_keeps_the_previous_generations_blobs() {
        let (vault, dir, _key, _id) = open_vault("gc-prev");
        let dir = dir.path();
        let runtime = temp_dir("gc-prev-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"gen1 content");
        vault.sync(runtime).unwrap();
        let gen1_blob = fs::read_dir(blobs_dir(dir)).unwrap().next().unwrap().unwrap().path();

        fs::write(runtime.join("data/a.txt"), b"gen2 content, different").unwrap();
        touch_mtime_forward(&runtime.join("data/a.txt"));
        vault.sync(runtime).unwrap();

        assert!(gen1_blob.exists(), "gen1's blob is still referenced by manifest.prev");

        // A third sync makes manifest.prev into gen2, at which point gen1's
        // blob is referenced by neither and gc should finally remove it.
        fs::write(runtime.join("data/a.txt"), b"gen3 content, also different").unwrap();
        touch_mtime_forward(&runtime.join("data/a.txt"));
        vault.sync(runtime).unwrap();
        assert!(!gen1_blob.exists(), "gen1's blob should be gc'd once it's unreferenced");
    }

    #[test]
    fn crash_between_blob_write_and_manifest_commit_keeps_old_generation_restorable() {
        let (vault, dir, key, vault_id) = open_vault("crash-mid-sync");
        let dir = dir.path();
        let runtime = temp_dir("crash-mid-sync-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a.txt", b"generation one content");
        vault.sync(runtime).unwrap();

        let before_manifest = fs::read(manifest_path(dir)).unwrap();

        // Simulate a crash between "new blob written" and "manifest
        // committed": write an orphan blob directly, bypassing `sync`'s
        // commit step entirely.
        let key_copy = Key32::from_slice(key.as_bytes()).unwrap();
        blobs::write(dir, &key_copy, &vault_id, b"never-committed content").unwrap();

        assert_eq!(fs::read(manifest_path(dir)).unwrap(), before_manifest, "manifest must be untouched by the orphan blob write");

        let restored = temp_dir("crash-mid-sync-restored");
        let restored = restored.path();
        let report = vault.restore(restored, |_| true).unwrap();
        assert_eq!(report.source, ManifestSource::Current);
        assert_eq!(report.restored, 1);
        assert_eq!(read_file(restored, "data/a.txt"), b"generation one content");
    }

    #[test]
    fn restore_filter_excludes_entries() {
        let (vault, _dir, _key, _id) = open_vault("filter");
        let runtime = temp_dir("filter-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/keep/me.txt", b"keep");
        write_file(runtime, "attachments/skip.jpg", b"skip");
        vault.sync(runtime).unwrap();

        let restored = temp_dir("filter-restored");
        let restored = restored.path();
        let report = vault.restore(restored, |relpath| !relpath.starts_with("attachments/")).unwrap();
        assert_eq!(report.restored, 1);
        assert!(restored.join("data/keep/me.txt").exists());
        assert!(!restored.join("attachments/skip.jpg").exists());
    }

    #[test]
    fn symlinks_in_the_runtime_dir_are_skipped() {
        let (vault, _dir, _key, _id) = open_vault("symlink");
        let runtime = temp_dir("symlink-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/real.txt", b"real content");
        let target = temp_dir("symlink-target");
        let target = target.path();
        write_file(target, "secret.txt", b"outside the runtime dir");
        std::os::unix::fs::symlink(target.join("secret.txt"), runtime.join("data/linked.txt")).unwrap();

        let report = vault.sync(runtime).unwrap();
        assert_eq!(report.changed, 1);

        let restored = temp_dir("symlink-restored");
        let restored = restored.path();
        vault.restore(restored, |_| true).unwrap();
        assert!(restored.join("data/real.txt").exists());
        assert!(!restored.join("data/linked.txt").exists());
    }

    #[test]
    fn a_stray_non_allowlisted_file_is_never_synced_or_restored() {
        // The exact shape of the real bug this allowlist fixes: an
        // installed signal-cli binary sitting next to real account data at
        // a path like `<legacy dir>/0.14.8/signal-cli` — outside every one
        // of `ALLOWED_TOP_DIRS` — must never be synced into the vault, and
        // (defense in depth) could never be restored even if it somehow
        // ended up in a manifest.
        let (vault, _dir, _key, _id) = open_vault("stray-top-level");
        let runtime = temp_dir("stray-top-level-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/account", b"real account data");
        write_file(runtime, "0.14.8/signal-cli", &vec![0xABu8; 4096]);

        let report = vault.sync(runtime).unwrap();
        assert_eq!(report.changed, 1, "only data/account should ever be synced");

        let restored = temp_dir("stray-top-level-restored");
        let restored = restored.path();
        let r = vault.restore(restored, |_| true).unwrap();
        assert_eq!(r.restored, 1);
        assert_eq!(read_file(restored, "data/account"), b"real account data");
        assert!(!restored.join("0.14.8").exists(), "the stray top-level entry must never be restored");
    }

    #[test]
    fn relpath_validation() {
        // "a/./b" is a valid relative path: `Path::components()` normalizes
        // away a non-leading `.`, and joining it onto `runtime_dir` can
        // never escape it, unlike a leading `.` or any `..`.
        for ok in ["a.txt", "a/b/c.txt", "data/account", "a/./b"] {
            assert!(validate_relpath(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../escape", "a/../b", "./a"] {
            assert!(validate_relpath(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 255, 16, 128];
        let hex = to_hex(&bytes);
        assert_eq!(hex, "0001ff1080");
        assert_eq!(from_hex(&hex).unwrap(), bytes);
        assert!(from_hex("xyz").is_none());
        assert!(from_hex("abc").is_none()); // odd length
    }

    #[test]
    fn file_modes_after_sync_and_restore() {
        let (vault, dir, _key, _id) = open_vault("modes");
        let dir = dir.path();
        let runtime = temp_dir("modes-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/a/b.txt", b"content");
        vault.sync(runtime).unwrap();

        let manifest_mode = fs::metadata(manifest_path(dir)).unwrap().permissions().mode() & 0o777;
        assert_eq!(manifest_mode, 0o600);
        let blob_path = fs::read_dir(blobs_dir(dir)).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::metadata(&blob_path).unwrap().permissions().mode() & 0o777, 0o600);

        let restored = temp_dir("modes-restored");
        let restored = restored.path();
        vault.restore(restored, |_| true).unwrap();
        assert_eq!(fs::metadata(restored).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(restored.join("data/a")).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(restored.join("data/a/b.txt")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn purge_non_allowlisted_drops_stray_entries_and_gcs_their_blobs_immediately() {
        let (vault, dir, _key, _id) = open_vault("purge");
        let dir = dir.path();
        let runtime = temp_dir("purge-runtime");
        let runtime = runtime.path();
        write_file(runtime, "data/account", b"real account data");
        vault.sync(runtime).unwrap();

        // Simulate a manifest left over from before `ALLOWED_TOP_DIRS`
        // existed: a stray entry pointing at its own (large) blob, written
        // directly so this test doesn't depend on `sync` ever having
        // allowed it through in the first place.
        let key_copy = Key32::from_slice(_key.as_bytes()).unwrap();
        let stray_blob = blobs::write(dir, &key_copy, &_id, &vec![0xCDu8; 4096]).unwrap();
        let (mut manifest, _source) = manifest::load_with_fallback(dir, &key_copy, &_id).unwrap();
        manifest.entries.insert(
            "0.14.8/signal-cli".to_string(),
            manifest::ManifestEntry { blob: blobs::id_to_hex(&stray_blob), size: 4096, mtime_ns: 0, sha256: to_hex(&[0u8; 32]) },
        );
        manifest.generation += 1;
        manifest::commit(dir, &key_copy, &_id, &manifest).unwrap();

        let stray_blob_path = blobs_dir(dir).join(blobs::id_to_hex(&stray_blob));
        assert!(stray_blob_path.exists(), "sanity: the stray blob was actually written");

        let removed = vault.purge_non_allowlisted().unwrap();
        assert_eq!(removed, 1);
        assert!(!stray_blob_path.exists(), "the stray entry's blob must be gc'd immediately, not after two more real syncs");

        // The real account data must be completely unaffected.
        let restored = temp_dir("purge-restored");
        let restored = restored.path();
        vault.restore(restored, |_| true).unwrap();
        assert_eq!(read_file(restored, "data/account"), b"real account data");

        // Idempotent: nothing left to purge the second time.
        assert_eq!(vault.purge_non_allowlisted().unwrap(), 0);
    }
}
