//! Orchestrates restore, sync and crash recovery around the signal-cli
//! runtime dir (docs/ENCRYPTION.md, "signal-cli vault", "Attachment
//! budget", "Crash recovery"). Still no Tauri commands or service wiring
//! here — that's task 4 — but this is where the three pieces (`Vault`, the
//! RAM-backed runtime dir, the instance lock) meet: `VaultSession::start`
//! decides whether it's looking at a clean slate or a crashed previous
//! session, `ensure_media`/`evict_media` implement the on-demand media
//! budget, and `shutdown` leaves things safe to start again either way.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::Error;

use super::lock::InstanceLock;
use super::manifest::{self, ManifestEntry};
use super::sync::{self, WalkEntry};
use super::{from_hex, io_err, restore, to_hex, validate_relpath, write_secure_file, Vault, MARKER_FILE_NAME, VAULT_ID_LEN};

/// Manifest relpath prefixes [`VaultSession::start`] never restores up
/// front: the bulk of a vault's bytes, hydrated instead by
/// [`VaultSession::ensure_media`] on demand (docs/ENCRYPTION.md,
/// "Attachment budget").
pub const MEDIA_PREFIXES: &[&str] = &["attachments/", "avatars/", "stickers/"];

/// Default runtime media budget (docs/ENCRYPTION.md, "Attachment budget").
pub const DEFAULT_MEDIA_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
/// Default idle time before an already-synced media file is eligible for
/// eviction (docs/ENCRYPTION.md, "Attachment budget").
pub const DEFAULT_MEDIA_IDLE: Duration = Duration::from_secs(10 * 60);

fn is_media(relpath: &str) -> bool {
    MEDIA_PREFIXES.iter().any(|prefix| relpath.starts_with(prefix))
}

/// What's recorded at `runtime_dir/.restored-from` right after a restore (or
/// a crash-recovery sync), so the next launch can tell this runtime dir
/// apart from a stale or foreign one.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Marker {
    vault_id: String,
    generation: u64,
}

fn marker_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(MARKER_FILE_NAME)
}

fn read_marker(runtime_dir: &Path) -> Option<Marker> {
    let bytes = fs::read(marker_path(runtime_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_marker(runtime_dir: &Path, vault_id: &[u8; VAULT_ID_LEN], generation: u64) -> Result<(), Error> {
    let marker = Marker { vault_id: to_hex(vault_id), generation };
    let json = serde_json::to_vec(&marker)
        .map_err(|e| Error::new(crate::error::ErrorKind::Internal, format!("vault: couldn't encode the recovery marker: {e}")))?;
    write_secure_file(&marker_path(runtime_dir), &json)
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false)
}

fn wipe_runtime_dir(runtime_dir: &Path) -> Result<(), Error> {
    match fs::remove_dir_all(runtime_dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(runtime_dir, e)),
    }
}

fn do_restore(vault: &Vault, runtime_dir: &Path) -> Result<(), Error> {
    vault.restore(runtime_dir, |relpath| !is_media(relpath))?;
    sweep_non_allowlisted(runtime_dir)?;
    let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
    write_marker(runtime_dir, &vault.vault_id, manifest.generation)
}

/// Removes anything directly under `runtime_dir` that isn't one of
/// [`super::ALLOWED_TOP_DIRS`] (or the crash-recovery marker) — a restore
/// itself can never write such a thing (`Vault::restore` never restores a
/// non-allowlisted manifest entry), but this also covers the `Recovered`
/// path, where the runtime dir is reused as-is rather than restored into,
/// and any stray leftover from before `ALLOWED_TOP_DIRS` existed.
fn sweep_non_allowlisted(runtime_dir: &Path) -> Result<(), Error> {
    let entries = match fs::read_dir(runtime_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(runtime_dir, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err(runtime_dir, e))?;
        let name = entry.file_name();
        if name == MARKER_FILE_NAME {
            continue;
        }
        let Some(name) = name.to_str() else {
            log::warn!("vault: sweep: skipping a non-UTF-8 entry under {}", runtime_dir.display());
            continue;
        };
        if super::ALLOWED_TOP_DIRS.contains(&name) {
            continue;
        }
        let path = entry.path();
        let result = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("vault: couldn't remove a stray non-allowlisted entry {}: {e}", path.display());
            }
        } else {
            log::warn!("vault: removed a stray non-allowlisted entry from the runtime dir: {}", path.display());
        }
    }
    Ok(())
}

/// What [`VaultSession::start`] found the runtime dir in. Exposed mainly for
/// logging and tests; task 4 doesn't need to branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartKind {
    /// Nothing usable was there: an ordinary restore.
    Fresh,
    /// A previous session of *this* vault crashed: the runtime dir's
    /// contents were synced into the vault before being reused as-is.
    Recovered,
    /// A runtime dir existed but wasn't recognizably this vault's (a
    /// foreign marker, or none at all): wiped, then restored fresh.
    Wiped,
}

/// What [`VaultSession::evict_media`] did.
#[derive(Debug, Clone, Default)]
pub struct EvictReport {
    /// Relpaths removed from the runtime dir, oldest-accessed first.
    pub evicted: Vec<String>,
    pub freed_bytes: u64,
    /// Total runtime media remaining after eviction.
    pub remaining_bytes: u64,
}

/// Ties a [`Vault`], its RAM-backed runtime dir and the process-wide
/// [`InstanceLock`] together for the lifetime of one signal-cli run.
pub struct VaultSession {
    vault: Vault,
    runtime_dir: PathBuf,
    _lock: InstanceLock,
    last_start: StartKind,
    /// In-memory only, per docs/ENCRYPTION.md's "Attachment budget": lost on
    /// restart, which just means every media file looks freshly accessed
    /// again right after a restore — never a correctness problem, since
    /// `evict_media` only ever removes files already safely in the vault.
    last_access: HashMap<String, Instant>,
}

impl VaultSession {
    /// Starts a session for `vault` against `runtime_dir`, having already
    /// taken `lock` (see [`InstanceLock::acquire`]).
    ///
    /// - A `.restored-from` marker whose vault id matches `vault`'s means
    ///   the previous session of *this* vault crashed and the runtime dir
    ///   is newer than the vault: it's synced in first, then reused as-is
    ///   (no restore over it).
    /// - A marker for a different vault, or a non-empty runtime dir with no
    ///   marker at all, is wiped (it's RAM-only, so nothing is lost that
    ///   matters) and then restored fresh.
    /// - Anything else (nothing there yet) is restored fresh.
    ///
    /// Either way, media (`MEDIA_PREFIXES`) is excluded from the restore
    /// and left to [`ensure_media`](Self::ensure_media).
    pub fn start(vault: Vault, runtime_dir: PathBuf, lock: InstanceLock) -> Result<Self, Error> {
        // Clean up any manifest entry left over from before `ALLOWED_TOP_DIRS`
        // existed — in particular one pointing at an installed signal-cli
        // binary rather than its data (docs/ENCRYPTION.md, "Migration") —
        // right at the start of every session rather than waiting on
        // ordinary sync activity to notice it's gone from the runtime dir.
        match vault.purge_non_allowlisted() {
            Ok(0) => {}
            Ok(removed) => log::info!("vault: purged {removed} non-allowlisted manifest entr(y/ies) and their blobs."),
            Err(e) => log::warn!("vault: couldn't purge non-allowlisted manifest entries: {e}"),
        }

        let marker = read_marker(&runtime_dir);
        let matches_vault =
            marker.as_ref().and_then(|m| from_hex(&m.vault_id)).is_some_and(|id| id.as_slice() == vault.vault_id.as_slice());

        let kind = if marker.is_some() && matches_vault {
            StartKind::Recovered
        } else if marker.is_some() || dir_has_entries(&runtime_dir) {
            StartKind::Wiped
        } else {
            StartKind::Fresh
        };

        match kind {
            StartKind::Recovered => {
                vault.sync(&runtime_dir)?;
                sweep_non_allowlisted(&runtime_dir)?;
                let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
                write_marker(&runtime_dir, &vault.vault_id, manifest.generation)?;
            }
            StartKind::Wiped | StartKind::Fresh => {
                wipe_runtime_dir(&runtime_dir)?;
                do_restore(&vault, &runtime_dir)?;
            }
        }

        Ok(Self { vault, runtime_dir, _lock: lock, last_start: kind, last_access: HashMap::new() })
    }

    /// What [`start`](Self::start) found, for logging/tests.
    pub fn last_start(&self) -> StartKind {
        self.last_start
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    /// Syncs the runtime dir into the vault (docs/ENCRYPTION.md, "Sync",
    /// "When to sync").
    pub fn sync(&self) -> Result<sync::SyncReport, Error> {
        self.vault.sync(&self.runtime_dir)
    }

    /// Records `relpath` as just accessed, without restoring anything.
    /// [`ensure_media`](Self::ensure_media) calls this itself; exposed
    /// separately for a caller that reads a file without going through it
    /// (e.g. one it knows is already present).
    pub fn touch(&mut self, relpath: &str) {
        self.last_access.insert(relpath.to_string(), Instant::now());
    }

    /// Hydrates `relpath` into the runtime dir if it's missing there but
    /// present in the vault's manifest (docs/ENCRYPTION.md, "Attachment
    /// budget"): decrypts it in place, verified, exactly like a full
    /// restore verifies every entry. Returns whether it actually restored
    /// anything — `false` both when the file was already there and when
    /// the manifest doesn't have it at all. Either way, a successful call
    /// (file present on return) counts as an access.
    pub fn ensure_media(&mut self, relpath: &str) -> Result<bool, Error> {
        validate_relpath(relpath)?;
        let full = self.runtime_dir.join(relpath);
        if full.is_file() {
            self.touch(relpath);
            return Ok(false);
        }
        let restored = restore::restore_one(&self.vault, &self.runtime_dir, relpath)?;
        if restored {
            self.touch(relpath);
        }
        Ok(restored)
    }

    /// Evicts already-synced, idle media once the runtime media total
    /// exceeds `budget_bytes` (docs/ENCRYPTION.md, "Attachment budget"):
    /// oldest-accessed first, stopping as soon as the total is back under
    /// budget. A media file is only ever a candidate if it's tracked in the
    /// current manifest with matching size, mtime and sha256 — an unsynced
    /// file (new, or changed since the last sync) is never evicted, no
    /// matter how idle it looks. Meant to run right after a
    /// [`sync`](Self::sync), so "already in the manifest" means "safe to
    /// delete and re-hydrate later".
    pub fn evict_media(&mut self, budget_bytes: u64, idle: Duration) -> Result<EvictReport, Error> {
        let (manifest, _source) = manifest::load_with_fallback(&self.vault.dir, &self.vault.key, &self.vault.vault_id)?;
        let entries = sync::walk(&self.runtime_dir)?;
        let media: Vec<&WalkEntry> = entries.iter().filter(|e| is_media(&e.relpath)).collect();

        let total: u64 = media.iter().map(|e| e.len).sum();
        if total <= budget_bytes {
            return Ok(EvictReport { evicted: Vec::new(), freed_bytes: 0, remaining_bytes: total });
        }

        let now = Instant::now();
        let mut candidates = Vec::new();
        for entry in &media {
            let accessed = self.last_access.get(&entry.relpath).copied();
            let idle_enough = match accessed {
                Some(t) => now.duration_since(t) >= idle,
                None => true,
            };
            if !idle_enough {
                continue;
            }
            if is_synced(manifest.entries.get(&entry.relpath), entry)? {
                candidates.push(*entry);
            }
        }
        // Oldest access first; never-accessed-this-session sorts first
        // (`None < Some(_)`), matching "restored a while ago and never
        // touched since" being at least as evictable as any recorded access.
        candidates.sort_by_key(|e| self.last_access.get(&e.relpath).copied());

        let mut remaining = total;
        let mut evicted = Vec::new();
        let mut freed = 0u64;
        for entry in candidates {
            if remaining <= budget_bytes {
                break;
            }
            fs::remove_file(&entry.path).map_err(|e| io_err(&entry.path, e))?;
            self.last_access.remove(&entry.relpath);
            remaining -= entry.len;
            freed += entry.len;
            evicted.push(entry.relpath.clone());
        }

        Ok(EvictReport { evicted, freed_bytes: freed, remaining_bytes: remaining })
    }

    /// A final sync, then wipes the runtime dir and releases the instance
    /// lock. If the sync fails, the runtime dir is deliberately left alone
    /// — it's still there for the next launch's crash recovery — and the
    /// error is returned; the lock is still released (dropped) either way,
    /// since this consumes the session regardless, but that's harmless: a
    /// marker matching this vault is exactly what makes the next `start`
    /// take the recovery path instead of restoring over unsynced changes.
    pub fn shutdown(self) -> Result<(), Error> {
        self.vault.sync(&self.runtime_dir)?;
        wipe_runtime_dir(&self.runtime_dir)
    }
}

/// Whether `entry` (a real runtime file) matches the manifest entry for its
/// relpath closely enough to be deleted without losing data: same size and
/// mtime first (cheap), then — only if those match — the same content hash.
/// `Ok(false)` (never evictable) if there's no manifest entry at all.
fn is_synced(manifest_entry: Option<&ManifestEntry>, entry: &WalkEntry) -> Result<bool, Error> {
    let Some(manifest_entry) = manifest_entry else {
        return Ok(false);
    };
    if manifest_entry.size != entry.len || manifest_entry.mtime_ns != entry.mtime_ns {
        return Ok(false);
    }
    let bytes = fs::read(&entry.path).map_err(|e| io_err(&entry.path, e))?;
    Ok(to_hex(&Sha256::digest(&bytes)) == manifest_entry.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;
    use crate::error::ErrorKind;
    use crate::vault::VAULT_ID_LEN;
    use std::fs;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-session-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    fn new_vault(base: &Path, vault_id: [u8; VAULT_ID_LEN]) -> Vault {
        Vault::open(&base.join("vault"), Key32::random(), vault_id).unwrap()
    }

    fn lock(base: &Path) -> InstanceLock {
        InstanceLock::acquire(&base.join("app-data")).unwrap()
    }

    fn write_file(dir: &Path, relpath: &str, contents: &[u8]) {
        let path = dir.join(relpath);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
    }

    #[test]
    fn fresh_start_restores_and_writes_a_marker() {
        let base = temp_dir("fresh");
        let base = base.path();
        let vault = new_vault(base, [1u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Fresh);
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"account data");
        assert!(read_marker(&runtime).is_some());
    }

    #[test]
    fn media_is_excluded_from_restore_then_hydrated_on_demand() {
        let base = temp_dir("media");
        let base = base.path();
        let vault = new_vault(base, [2u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(runtime.join("data/account").exists());
        assert!(!runtime.join("attachments/photo.jpg").exists(), "media must not be restored up front");

        let restored = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(restored);
        assert_eq!(fs::read(runtime.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");

        // Second call: already present, nothing to do.
        let restored_again = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(!restored_again);

        // Not in the manifest at all.
        let missing = session.ensure_media("attachments/nope.jpg").unwrap();
        assert!(!missing);
    }

    #[test]
    fn crash_recovery_syncs_the_modification_and_keeps_the_runtime_dir() {
        let base = temp_dir("crash");
        let base = base.path();
        let vault_id = [3u8; VAULT_ID_LEN];
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let runtime = base.join("runtime");

        let vault1 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        write_file(&runtime, "data/account", b"original");
        vault1.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session1 = VaultSession::start(vault1, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session1.last_start(), StartKind::Fresh);

        // signal-cli (simulated) keeps writing; the process then "crashes":
        // dropped without calling `shutdown`, so no final sync and the lock
        // is simply released by the fd closing.
        fs::write(runtime.join("data/account"), b"modified after start, never synced").unwrap();
        drop(session1);

        let vault2 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let session2 = VaultSession::start(vault2, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session2.last_start(), StartKind::Recovered);
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"modified after start, never synced");

        // And it really did make it into the vault, not just stay on disk:
        // a fresh restore elsewhere must see the modification too.
        let check_vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let restored_elsewhere = temp_dir("crash-restored-elsewhere");
        let restored_elsewhere = restored_elsewhere.path();
        check_vault.restore(restored_elsewhere, |_| true).unwrap();
        assert_eq!(fs::read(restored_elsewhere.join("data/account")).unwrap(), b"modified after start, never synced");
    }

    #[test]
    fn a_foreign_marker_gets_wiped_not_recovered() {
        let base = temp_dir("foreign");
        let base = base.path();
        let vault = new_vault(base, [4u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"vault content");
        vault.sync(&runtime).unwrap();
        // Clear the vault's own marker and plant one for a different vault,
        // plus an unrelated leftover file that must not survive the wipe.
        let _ = fs::remove_file(marker_path(&runtime));
        write_marker(&runtime, &[0xffu8; VAULT_ID_LEN], 1).unwrap();
        write_file(&runtime, "stray.txt", b"leftover from somewhere else");

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Wiped);
        assert!(!runtime.join("stray.txt").exists());
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"vault content");
    }

    #[test]
    fn a_runtime_dir_with_no_marker_at_all_gets_wiped() {
        let base = temp_dir("no-marker");
        let base = base.path();
        let vault = new_vault(base, [5u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"vault content");
        vault.sync(&runtime).unwrap();
        // `vault.sync` alone never writes a marker (only `VaultSession::start`
        // does) — this directory is exactly "content with no marker at all".
        write_file(&runtime, "stray.txt", b"no marker, no trust");

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Wiped);
        assert!(!runtime.join("stray.txt").exists());
    }

    #[test]
    fn eviction_respects_budget_idle_and_the_unsynced_rule() {
        let base = temp_dir("evict");
        let base = base.path();
        let vault = new_vault(base, [6u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");

        // Start with nothing to restore, then write media straight into the
        // running session's runtime dir and sync it: that's the only way to
        // get a manifest entry whose recorded mtime exactly matches the
        // real file's mtime, which `is_synced` requires.
        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        write_file(&runtime, "attachments/old.bin", &[0u8; 100]);
        write_file(&runtime, "attachments/recent.bin", &[0u8; 100]);
        session.sync().unwrap();

        // `recent.bin` was just "accessed"; `old.bin` never was this session.
        session.touch("attachments/recent.bin");
        // Created after the sync above: present on disk, but not in the
        // manifest at all, so it must never be evicted.
        write_file(&runtime, "attachments/unsynced.bin", &[0u8; 100]);

        let report = session.evict_media(100, Duration::from_secs(600)).unwrap();
        assert_eq!(report.evicted, vec!["attachments/old.bin".to_string()]);
        assert_eq!(report.freed_bytes, 100);
        assert!(!runtime.join("attachments/old.bin").exists());
        assert!(runtime.join("attachments/recent.bin").exists(), "recently accessed, must survive");
        assert!(runtime.join("attachments/unsynced.bin").exists(), "never synced, must never be evicted");
    }

    #[test]
    fn eviction_is_a_no_op_under_budget() {
        let base = temp_dir("evict-under-budget");
        let base = base.path();
        let vault = new_vault(base, [7u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        write_file(&runtime, "attachments/a.bin", &[0u8; 10]);
        session.sync().unwrap();

        let report = session.evict_media(1_000_000, Duration::ZERO).unwrap();
        assert!(report.evicted.is_empty());
        assert!(runtime.join("attachments/a.bin").exists());
    }

    #[test]
    fn shutdown_syncs_then_wipes_and_releases_the_lock() {
        let base = temp_dir("shutdown-ok");
        let base = base.path();
        let vault = new_vault(base, [8u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"v1");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        fs::write(runtime.join("data/account"), b"v2, synced on shutdown").unwrap();
        session.shutdown().unwrap();

        assert!(!runtime.exists(), "runtime dir must be wiped after a clean shutdown");
        // The lock was released: a new acquisition over the same app data
        // dir must succeed.
        let _relocked = lock(base);
    }

    #[test]
    fn shutdown_keeps_the_runtime_dir_when_the_final_sync_fails() {
        let base = temp_dir("shutdown-fail");
        let base = base.path();
        let vault = new_vault(base, [9u8; VAULT_ID_LEN]);
        let vault_dir = base.join("vault");
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"v1");
        vault.sync(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();

        // Corrupt both manifest generations so the final sync's own
        // `load_with_fallback` fails with `VaultCorrupt`.
        fs::write(vault_dir.join("manifest"), b"not sealed data").unwrap();
        fs::write(vault_dir.join("manifest.prev"), b"also not sealed data").unwrap();

        let err = session.shutdown().unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);
        assert!(runtime.exists(), "the runtime dir must survive a failed final sync, for crash recovery");
        assert!(runtime.join("data/account").exists());
    }

    #[test]
    fn the_marker_is_never_synced_into_the_vault() {
        let base = temp_dir("marker-not-synced");
        let base = base.path();
        let vault_id = [10u8; VAULT_ID_LEN];
        let key = Key32::random();
        let vault_dir = base.join("vault");
        let vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"content");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(read_marker(&runtime).is_some(), "sanity: the marker really is on disk");
        session.sync().unwrap();

        // Reopen the same vault (same key) to check its contents directly,
        // since `session` now owns the original `Vault` value.
        let check_vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let restored = temp_dir("marker-not-synced-restored");
        let restored = restored.path();
        check_vault.restore(restored, |_| true).unwrap();
        assert!(!restored.join(MARKER_FILE_NAME).exists());
    }
}
