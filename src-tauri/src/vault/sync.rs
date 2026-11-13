//! Runtime → vault sync (docs/ENCRYPTION.md, "Sync"): diff the runtime dir
//! against the current manifest, copy every changed file with whichever
//! strategy `copy` picks for it, write each one to a brand new blob, commit
//! a new manifest generation, then garbage-collect. Writes nothing at all
//! if nothing changed.
//!
//! A manifest entry whose relpath is missing from the runtime dir isn't
//! automatically "deleted": [`sync`]/[`sync_walked`] take an explicit
//! `keep_if_absent` predicate for exactly this, so this module stays a pure
//! function of its inputs rather than knowing anything about
//! `session::VaultSession`'s on-demand media. [`Vault::sync`](super::Vault::sync)
//! passes a predicate that never keeps anything (today's plain behaviour:
//! absent always means deleted); `VaultSession` passes one that also keeps
//! a media relpath this session hasn't materialized (seen present on a walk,
//! or hydrated via `ensure_media`) — see docs/ENCRYPTION.md, "Sync" and
//! "Attachment budget".

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::error::Error;

use super::blobs::{self, BlobId};
use super::copy;
use super::manifest::{self, Manifest, ManifestEntry};
use super::{io_err, is_allowlisted, to_hex, validate_relpath, Vault};

/// A file `sync` couldn't copy after exhausting its retries. The previous
/// manifest entry for it (if any) was left unchanged this round, so it'll
/// be retried again on the next sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    pub relpath: String,
    pub reason: String,
}

/// What a [`Vault::sync`] did.
#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    /// `false` means nothing changed and nothing was written — not even a
    /// new manifest generation.
    pub wrote: bool,
    pub generation: u64,
    /// Files written to a new blob this round (new or modified).
    pub changed: usize,
    pub deleted: usize,
    pub skipped: Vec<SkippedFile>,
    pub removed_blobs: usize,
}

/// One file found under the runtime dir. `pub(crate)` so
/// `session::VaultSession::evict_media` can reuse the same walk — and the
/// same symlink/sidecar/non-UTF-8 skipping — rather than duplicating it.
pub(crate) struct WalkEntry {
    pub(crate) relpath: String,
    pub(crate) path: PathBuf,
    pub(crate) len: u64,
    pub(crate) mtime_ns: u64,
    /// `(len, mtime_ns)` of a `*.db` file's `-wal` sidecar, `None` for any
    /// other file or a database with no WAL file. A WAL-mode database takes
    /// its writes in the `-wal` file and only moves them into the `.db`
    /// itself at a checkpoint, so the `.db`'s own size and mtime can stay
    /// put while committed data piles up beside it.
    pub(crate) wal: Option<(u64, u64)>,
}

fn is_db(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "db")
}

/// What [`sync_walked_with`] last saw of a database the last time it copied
/// it: the `.db` file's own stat plus its `-wal` sidecar's. In memory only
/// (the manifest schema is unchanged), so it starts empty with every
/// session, which is the safe direction: an unknown database whose WAL isn't
/// empty is copied once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DbPrint {
    len: u64,
    mtime_ns: u64,
    wal: (u64, u64),
}

pub(crate) type DbPrints = HashMap<String, DbPrint>;

fn print_of(entry: &WalkEntry) -> DbPrint {
    DbPrint { len: entry.len, mtime_ns: entry.mtime_ns, wal: entry.wal.unwrap_or((0, 0)) }
}

/// Test-only injection points, keyed by vault directory so parallel tests
/// can't see each other's hooks: the production code calls [`fire`] at a few
/// named points, and a test can park a pass there or count what reached it.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    type Hook = Arc<dyn Fn(&str, &str) + Send + Sync>;
    static HOOKS: Mutex<Vec<(PathBuf, Hook)>> = Mutex::new(Vec::new());

    pub(crate) fn set(vault_dir: &Path, hook: impl Fn(&str, &str) + Send + Sync + 'static) {
        HOOKS.lock().unwrap().push((vault_dir.to_path_buf(), Arc::new(hook)));
    }

    /// Forgets every hook registered for this vault.
    pub(crate) fn clear(vault_dir: &Path) {
        HOOKS.lock().unwrap().retain(|(dir, _)| dir != vault_dir);
    }

    /// Tells a test that `point` was reached, without holding anyone up.
    pub(crate) struct Notified(Mutex<Receiver<()>>);

    pub(crate) fn notify_at(vault_dir: &Path, point: &'static str) -> Notified {
        let (tx, rx) = channel::<()>();
        let tx = Mutex::new(tx);
        set(vault_dir, move |p, _| {
            if p == point {
                let _ = tx.lock().unwrap().send(());
            }
        });
        Notified(Mutex::new(rx))
    }

    impl Notified {
        pub(crate) fn wait(&self, timeout: Duration) -> bool {
            self.0.lock().unwrap().recv_timeout(timeout).is_ok()
        }
    }

    pub(crate) fn fire(vault_dir: &Path, point: &str, detail: &str) {
        let hooks: Vec<Hook> = HOOKS.lock().unwrap().iter().filter(|(dir, _)| dir == vault_dir).map(|(_, h)| h.clone()).collect();
        for hook in hooks {
            hook(point, detail);
        }
    }

    /// Everything `point` fired with (its detail string) for this vault, in order.
    pub(crate) fn record(vault_dir: &Path, point: &'static str) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        set(vault_dir, move |p, detail| {
            if p == point {
                sink.lock().unwrap().push(detail.to_string());
            }
        });
        seen
    }

    /// Parks every thread that reaches `point` for this vault until
    /// [`Park::release`] (or the `Park` is dropped, so a failing test can't
    /// leave a thread stuck).
    pub(crate) struct Park {
        entered: Mutex<Receiver<()>>,
        release: Option<Sender<()>>,
        vault_dir: PathBuf,
    }

    impl Drop for Park {
        fn drop(&mut self) {
            self.release.take(); // let any parked thread go before the hooks vanish
            clear(&self.vault_dir);
        }
    }

    pub(crate) fn park_at(vault_dir: &Path, point: &'static str) -> Park {
        let (entered_tx, entered_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let release_rx = Mutex::new(release_rx);
        set(vault_dir, move |p, _| {
            if p == point {
                let _ = entered_tx.send(());
                let _ = release_rx.lock().unwrap().recv();
            }
        });
        Park { entered: Mutex::new(entered_rx), release: Some(release_tx), vault_dir: vault_dir.to_path_buf() }
    }

    impl Park {
        /// Whether a thread reached the point within `timeout`.
        pub(crate) fn wait_entered(&self, timeout: Duration) -> bool {
            self.entered.lock().unwrap().recv_timeout(timeout).is_ok()
        }

        pub(crate) fn release(&mut self) {
            self.release.take();
        }
    }
}

fn is_sidecar(name: &str) -> bool {
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

fn mtime_ns(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// Recursively walks `runtime_dir`, skipping `*-wal`/`*-shm`/`*-journal`
/// sidecars, the crash-recovery marker (`MARKER_FILE_NAME`; it must never
/// become a tracked manifest entry), symlinks (warned, never followed),
/// non-UTF-8 names (warned), and anything outside
/// [`super::ALLOWED_TOP_DIRS`] (an entire non-allowlisted subtree is skipped
/// without descending into it, rather than filtered file by file).
pub(crate) fn walk(runtime_dir: &Path) -> Result<Vec<WalkEntry>, Error> {
    let mut out = Vec::new();
    walk_into(runtime_dir, runtime_dir, &mut out)?;
    Ok(out)
}

fn walk_into(root: &Path, dir: &Path, out: &mut Vec<WalkEntry>) -> Result<(), Error> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(dir, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err(dir, e))?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| io_err(&path, e))?;
        if file_type.is_symlink() {
            log::warn!("vault: sync: skipping symlink {}", path.display());
            continue;
        }
        let Some(relpath) = path.strip_prefix(root).ok().and_then(|p| p.to_str()).map(str::to_owned) else {
            log::warn!("vault: sync: skipping a non-UTF-8 path under {}", root.display());
            continue;
        };
        if !is_allowlisted(&relpath) {
            // Not one of signal-cli's own data dirs (`super::ALLOWED_TOP_DIRS`):
            // never synced, and — for a directory — never even descended
            // into, so an install's worth of files under it costs nothing
            // more than this one check.
            continue;
        }
        if file_type.is_dir() {
            walk_into(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue; // sockets, devices, fifos: signal-cli never writes these.
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_sidecar(&name_str) || name_str == super::MARKER_FILE_NAME {
            continue;
        }
        let meta = entry.metadata().map_err(|e| io_err(&path, e))?;
        let wal = if is_db(&path) {
            let mut wal_path = path.clone().into_os_string();
            wal_path.push("-wal");
            fs::metadata(PathBuf::from(wal_path)).ok().map(|m| (m.len(), mtime_ns(&m)))
        } else {
            None
        };
        out.push(WalkEntry { relpath, path, len: meta.len(), mtime_ns: mtime_ns(&meta), wal });
    }
    Ok(())
}

/// Copies one changed file with the strategy its name picks, retrying up to
/// 3 times with backoff on a lock timeout or a JSON parse failure (the only
/// two [`copy::Retry`] reasons for non-database files; a SQLite backup
/// failure is retried the same way for consistency, though it isn't
/// normally transient).
fn copy_one(path: &Path, vault_dir: &Path) -> Result<Vec<u8>, String> {
    let is_db = is_db(path);
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        #[cfg(test)]
        test_hooks::fire(vault_dir, "copy", &path.to_string_lossy());
        let result = if is_db { copy::copy_sqlite(path, vault_dir) } else { copy::copy_locked(path) };
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(20u64 * 2u64.pow(attempt)));
            }
        }
    }
    Err(last_err)
}

/// Walks `runtime_dir` itself, then delegates to [`sync_walked`]. Most
/// callers (anything that doesn't already have a walk lying around) want
/// this; `session::VaultSession::sync` reuses its own walk (it needs one
/// anyway, to track which media relpaths are now present) and calls
/// [`sync_walked`] directly instead.
pub(crate) fn sync(vault: &Vault, runtime_dir: &Path, keep_if_absent: impl Fn(&str) -> bool) -> Result<SyncReport, Error> {
    let walked = walk(runtime_dir)?;
    sync_walked(vault, &walked, keep_if_absent)
}

/// Diffs an already-[`walk`]ed runtime dir against the current manifest,
/// copies every changed file into a new blob, and commits a new manifest
/// generation. Writes nothing at all if nothing changed.
///
/// A manifest relpath absent from `walked` is normally treated as deleted —
/// unless `keep_if_absent` says otherwise for it, in which case its entry is
/// carried over unchanged (not deleted, not re-copied, not counted in the
/// returned `deleted`). See this module's docs for why that exists.
pub(crate) fn sync_walked(vault: &Vault, walked: &[WalkEntry], keep_if_absent: impl Fn(&str) -> bool) -> Result<SyncReport, Error> {
    sync_walked_with(vault, walked, keep_if_absent, &mut DbPrints::new())
}

/// [`sync_walked`] with the caller's record of what it last copied of each
/// database (`prints`), which is what lets a database with pending WAL
/// content be told apart from one that is genuinely unchanged.
///
/// A file whose size and mtime match its manifest entry is skipped without
/// being read. A `*.db` file gets one more check, because its own size and
/// mtime say nothing about writes still sitting in its `-wal`: it's skipped
/// only if the WAL is empty or absent, or if `prints` shows this exact
/// `.db`+WAL state was already copied. Callers must not run two of these at
/// once against one vault (each reads the manifest, then commits the next
/// generation); `session::SessionHandle` serialises them.
pub(crate) fn sync_walked_with(
    vault: &Vault,
    walked: &[WalkEntry],
    keep_if_absent: impl Fn(&str) -> bool,
    prints: &mut DbPrints,
) -> Result<SyncReport, Error> {
    let (old_manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;

    let mut new_entries = old_manifest.entries.clone();
    let mut skipped = Vec::new();
    let mut changed = 0usize;
    // Database fingerprints, applied to `prints` only once this pass's data is
    // durable (manifest committed), so a failed blob write or commit can't
    // leave a print claiming a state the vault doesn't hold.
    let mut staged: Vec<(String, DbPrint)> = Vec::new();

    let present: HashSet<&str> = walked.iter().map(|w| w.relpath.as_str()).collect();
    let deleted_keys: Vec<String> =
        old_manifest.entries.keys().filter(|k| !present.contains(k.as_str()) && !keep_if_absent(k.as_str())).cloned().collect();
    for key in &deleted_keys {
        new_entries.remove(key);
    }
    prints.retain(|relpath, _| present.contains(relpath.as_str()));

    for entry in walked {
        validate_relpath(&entry.relpath)?;

        let unchanged_by_stat =
            old_manifest.entries.get(&entry.relpath).is_some_and(|old| old.size == entry.len && old.mtime_ns == entry.mtime_ns);
        let db = is_db(&entry.path);
        if unchanged_by_stat {
            let wal_pending = db && entry.wal.is_some_and(|(len, _)| len > 0);
            if !wal_pending || prints.get(&entry.relpath) == Some(&print_of(entry)) {
                continue; // cheap path: trust size+mtime, no copy, no hash, no new blob.
            }
        }

        match copy_one(&entry.path, &vault.dir) {
            Ok(plaintext) => {
                if db {
                    // Taken from the walk, i.e. from before the copy: a write
                    // that lands during the backup changes the WAL's stat and
                    // makes the next pass copy again.
                    staged.push((entry.relpath.clone(), print_of(entry)));
                }
                let sha256 = to_hex(&Sha256::digest(&plaintext));
                let same_content = old_manifest.entries.get(&entry.relpath).is_some_and(|old| old.sha256 == sha256);
                if same_content {
                    // size/mtime moved but content didn't: no new blob, but
                    // record the new stat so the next pass skips this file.
                    if let Some(old) = new_entries.get_mut(&entry.relpath) {
                        old.size = entry.len;
                        old.mtime_ns = entry.mtime_ns;
                    }
                    continue;
                }
                let id = blobs::write(&vault.dir, &vault.key, &vault.vault_id, &plaintext)?;
                new_entries.insert(
                    entry.relpath.clone(),
                    ManifestEntry { blob: blobs::id_to_hex(&id), size: entry.len, mtime_ns: entry.mtime_ns, sha256 },
                );
                changed += 1;
            }
            Err(reason) => {
                skipped.push(SkippedFile { relpath: entry.relpath.clone(), reason });
                // Leave `new_entries` as the clone of the old entry (if any);
                // a brand new file that never copies successfully is simply
                // absent and will be retried as "new" again next sync.
            }
        }
    }

    if new_entries == old_manifest.entries {
        prints.extend(staged);
        return Ok(SyncReport { wrote: false, generation: old_manifest.generation, changed: 0, deleted: 0, skipped, removed_blobs: 0 });
    }

    let new_manifest = Manifest { generation: old_manifest.generation + 1, entries: new_entries };
    #[cfg(test)]
    test_hooks::fire(&vault.dir, "commit", "");
    manifest::commit(&vault.dir, &vault.key, &vault.vault_id, &new_manifest)?;
    prints.extend(staged);
    #[cfg(test)]
    test_hooks::fire(&vault.dir, "gc", "");

    let mut keep: HashSet<BlobId> = HashSet::new();
    for e in new_manifest.entries.values().chain(old_manifest.entries.values()) {
        if let Some(id) = blobs::id_from_hex(&e.blob) {
            keep.insert(id);
        }
    }
    let removed_blobs = blobs::gc(&vault.dir, &keep)? + copy::gc_stray_tmp(&vault.dir)?;

    Ok(SyncReport {
        wrote: true,
        generation: new_manifest.generation,
        changed,
        deleted: deleted_keys.len(),
        skipped,
        removed_blobs,
    })
}

/// Drops any manifest entry outside [`super::ALLOWED_TOP_DIRS`] and garbage-
/// collects its blob right away. `0` (and nothing committed) when the
/// manifest is already clean.
///
/// An ordinary [`sync`] only ever *adds* such an entry's relpath to
/// `deleted_keys` once it's absent from a (now allowlist-filtered) walk of
/// the runtime dir — so a stray entry does eventually disappear on its own,
/// but its blob stays in `keep` for one extra generation (the
/// `manifest.prev` fallback's usual grace period), and `keep` is computed
/// fresh from whatever's on disk *right then*, which a caller who just wants
/// the stray gone immediately (`VaultSession::start`, right after unlock)
/// has no way to force by waiting. This commits the already-filtered
/// manifest twice in a row instead: the first commit demotes the
/// stray-containing manifest to `manifest.prev`, and the second (identical)
/// commit demotes *that* one out of `manifest.prev` too, so gc's `keep` set
/// — built from the current and previous generations, same as [`sync`]'s —
/// contains no reference to the stray entry's blob at all, on this very
/// call.
pub(crate) fn purge_non_allowlisted(vault: &Vault) -> Result<usize, Error> {
    let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
    let filtered: BTreeMap<String, ManifestEntry> =
        manifest.entries.iter().filter(|(relpath, _)| is_allowlisted(relpath)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let removed = manifest.entries.len() - filtered.len();
    if removed == 0 {
        return Ok(0);
    }

    let first = Manifest { generation: manifest.generation + 1, entries: filtered.clone() };
    manifest::commit(&vault.dir, &vault.key, &vault.vault_id, &first)?;
    let second = Manifest { generation: first.generation + 1, entries: filtered };
    manifest::commit(&vault.dir, &vault.key, &vault.vault_id, &second)?;

    let mut keep: HashSet<BlobId> = HashSet::new();
    for e in second.entries.values().chain(first.entries.values()) {
        if let Some(id) = blobs::id_from_hex(&e.blob) {
            keep.insert(id);
        }
    }
    blobs::gc(&vault.dir, &keep)?;

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;
    use crate::vault::VAULT_ID_LEN;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-sync-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    #[test]
    fn walk_skips_sqlite_sidecars() {
        let dir = temp_dir("sidecars");
        let dir = dir.path().join("data");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("account.db"), b"db").unwrap();
        fs::write(dir.join("account.db-wal"), b"wal").unwrap();
        fs::write(dir.join("account.db-shm"), b"shm").unwrap();
        fs::write(dir.join("account.db-journal"), b"journal").unwrap();
        let entries = walk(dir.parent().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relpath, "data/account.db");
    }

    #[test]
    fn walk_skips_entries_outside_the_allowlisted_top_dirs() {
        let dir = temp_dir("non-allowlisted");
        let dir = dir.path();
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("data/account"), b"real data").unwrap();
        // An installed signal-cli binary, the exact shape of the real bug
        // `ALLOWED_TOP_DIRS` fixes.
        fs::create_dir_all(dir.join("0.14.8")).unwrap();
        fs::write(dir.join("0.14.8/signal-cli"), b"not real signal-cli data").unwrap();

        let entries = walk(dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relpath, "data/account");
    }

    #[test]
    fn json_retry_exhaustion_skips_the_file_and_keeps_no_entry() {
        let base = temp_dir("json-retry");
        let base = base.path();
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let vault = Vault::open(&vault_dir, key, [5u8; VAULT_ID_LEN]).unwrap();
        let runtime = base.join("runtime");
        fs::create_dir_all(runtime.join("data")).unwrap();
        fs::write(runtime.join("data/bad.json"), b"{ this never parses").unwrap();

        let report = sync(&vault, &runtime, |_| false).unwrap();
        assert_eq!(report.changed, 0);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].relpath, "data/bad.json");
        assert!(!report.wrote); // nothing ever successfully copied, so nothing to commit
    }

    /// A real SQLite database in WAL mode, with an open writer connection
    /// throughout the sync: the online backup API must still produce a
    /// consistent snapshot of everything committed so far.
    #[test]
    fn syncs_a_wal_mode_database_with_an_open_writer() {
        let base = temp_dir("sqlite-wal");
        let base = base.path();
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let vault = Vault::open(&vault_dir, key, [6u8; VAULT_ID_LEN]).unwrap();
        let runtime = base.join("runtime");
        fs::create_dir_all(runtime.join("data")).unwrap();

        let db_path = runtime.join("data/account.db");
        let writer = rusqlite::Connection::open(&db_path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE msgs (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["hello"]).unwrap();
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["world"]).unwrap();
        // Committed via autocommit above; WAL content hasn't been checkpointed
        // into account.db yet, so a plain file copy would lose it.
        assert!(runtime.join("data/account.db-wal").exists());

        let report = sync(&vault, &runtime, |_| false).unwrap();
        assert!(report.wrote);
        assert_eq!(report.changed, 1);

        // The writer stays open and keeps going, proving the backup didn't
        // need exclusive access.
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["after-sync"]).unwrap();

        let restored = base.join("restored");
        vault.restore(&restored, |_| true).unwrap();
        let restored_db = restored.join("data/account.db");
        assert!(restored_db.exists());
        assert!(!restored.join("data/account.db-wal").exists(), "only the .db file is ever written on restore");

        let check = rusqlite::Connection::open(&restored_db).unwrap();
        let integrity: String = check.query_row("PRAGMA integrity_check", [], |row| row.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let mut rows: Vec<String> =
            check.prepare("SELECT body FROM msgs ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        rows.sort();
        let mut expected = vec!["hello".to_string(), "world".to_string()];
        expected.sort();
        assert_eq!(rows, expected);
    }
}
