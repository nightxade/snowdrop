//! Runtime → vault sync (docs/ENCRYPTION.md, "Sync"): diff the runtime dir
//! against the current manifest, copy every changed file with whichever
//! strategy `copy` picks for it, write each one to a brand new blob, commit
//! a new manifest generation, then garbage-collect. Writes nothing at all
//! if nothing changed.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::error::Error;

use super::blobs::{self, BlobId};
use super::copy;
use super::manifest::{self, Manifest, ManifestEntry};
use super::{io_err, to_hex, validate_relpath, Vault};

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

struct WalkEntry {
    relpath: String,
    path: PathBuf,
    len: u64,
    mtime_ns: u64,
}

fn is_sidecar(name: &str) -> bool {
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

fn mtime_ns(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// Recursively walks `runtime_dir`, skipping `*-wal`/`*-shm`/`*-journal`
/// sidecars, symlinks (warned, never followed) and non-UTF-8 names (warned).
fn walk(runtime_dir: &Path) -> Result<Vec<WalkEntry>, Error> {
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
        if file_type.is_dir() {
            walk_into(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue; // sockets, devices, fifos: signal-cli never writes these.
        }
        let name = entry.file_name();
        if is_sidecar(&name.to_string_lossy()) {
            continue;
        }
        let meta = entry.metadata().map_err(|e| io_err(&path, e))?;
        out.push(WalkEntry { relpath, path, len: meta.len(), mtime_ns: mtime_ns(&meta) });
    }
    Ok(())
}

/// Copies one changed file with the strategy its name picks, retrying up to
/// 3 times with backoff on a lock timeout or a JSON parse failure (the only
/// two [`copy::Retry`] reasons for non-database files; a SQLite backup
/// failure is retried the same way for consistency, though it isn't
/// normally transient).
fn copy_one(path: &Path, vault_dir: &Path) -> Result<Vec<u8>, String> {
    let is_db = path.extension().is_some_and(|ext| ext == "db");
    let mut last_err = String::new();
    for attempt in 0..3u32 {
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

pub(crate) fn sync(vault: &Vault, runtime_dir: &Path) -> Result<SyncReport, Error> {
    let (old_manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
    let walked = walk(runtime_dir)?;

    let mut new_entries = old_manifest.entries.clone();
    let mut skipped = Vec::new();
    let mut changed = 0usize;

    let present: HashSet<&str> = walked.iter().map(|w| w.relpath.as_str()).collect();
    let deleted_keys: Vec<String> = old_manifest.entries.keys().filter(|k| !present.contains(k.as_str())).cloned().collect();
    for key in &deleted_keys {
        new_entries.remove(key);
    }

    for entry in &walked {
        validate_relpath(&entry.relpath)?;

        let unchanged_by_stat =
            old_manifest.entries.get(&entry.relpath).is_some_and(|old| old.size == entry.len && old.mtime_ns == entry.mtime_ns);
        if unchanged_by_stat {
            continue; // cheap path: trust size+mtime, no copy, no hash, no new blob.
        }

        match copy_one(&entry.path, &vault.dir) {
            Ok(plaintext) => {
                let sha256 = to_hex(&Sha256::digest(&plaintext));
                let same_content = old_manifest.entries.get(&entry.relpath).is_some_and(|old| old.sha256 == sha256);
                if same_content {
                    continue; // size/mtime moved but content didn't: avoid a needless rewrite.
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
        return Ok(SyncReport { wrote: false, generation: old_manifest.generation, changed: 0, deleted: 0, skipped, removed_blobs: 0 });
    }

    let new_manifest = Manifest { generation: old_manifest.generation + 1, entries: new_entries };
    manifest::commit(&vault.dir, &vault.key, &vault.vault_id, &new_manifest)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;
    use crate::vault::VAULT_ID_LEN;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-vault-sync-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn walk_skips_sqlite_sidecars() {
        let dir = temp_dir("sidecars");
        fs::write(dir.join("account.db"), b"db").unwrap();
        fs::write(dir.join("account.db-wal"), b"wal").unwrap();
        fs::write(dir.join("account.db-shm"), b"shm").unwrap();
        fs::write(dir.join("account.db-journal"), b"journal").unwrap();
        let entries = walk(&dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relpath, "account.db");
    }

    #[test]
    fn json_retry_exhaustion_skips_the_file_and_keeps_no_entry() {
        let base = temp_dir("json-retry");
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let vault = Vault::open(&vault_dir, key, [5u8; VAULT_ID_LEN]).unwrap();
        let runtime = base.join("runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("bad.json"), b"{ this never parses").unwrap();

        let report = sync(&vault, &runtime).unwrap();
        assert_eq!(report.changed, 0);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].relpath, "bad.json");
        assert!(!report.wrote); // nothing ever successfully copied, so nothing to commit
    }

    /// A real SQLite database in WAL mode, with an open writer connection
    /// throughout the sync: the online backup API must still produce a
    /// consistent snapshot of everything committed so far.
    #[test]
    fn syncs_a_wal_mode_database_with_an_open_writer() {
        let base = temp_dir("sqlite-wal");
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let vault = Vault::open(&vault_dir, key, [6u8; VAULT_ID_LEN]).unwrap();
        let runtime = base.join("runtime");
        fs::create_dir_all(&runtime).unwrap();

        let db_path = runtime.join("account.db");
        let writer = rusqlite::Connection::open(&db_path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE msgs (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["hello"]).unwrap();
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["world"]).unwrap();
        // Committed via autocommit above; WAL content hasn't been checkpointed
        // into account.db yet, so a plain file copy would lose it.
        assert!(runtime.join("account.db-wal").exists());

        let report = sync(&vault, &runtime).unwrap();
        assert!(report.wrote);
        assert_eq!(report.changed, 1);

        // The writer stays open and keeps going, proving the backup didn't
        // need exclusive access.
        writer.execute("INSERT INTO msgs (body) VALUES (?1)", ["after-sync"]).unwrap();

        let restored = base.join("restored");
        vault.restore(&restored, |_| true).unwrap();
        let restored_db = restored.join("account.db");
        assert!(restored_db.exists());
        assert!(!restored.join("account.db-wal").exists(), "only the .db file is ever written on restore");

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
