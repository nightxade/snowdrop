//! Per-file copy strategies for `sync` (docs/ENCRYPTION.md, "Sync"):
//!
//! - **`*.db` (SQLite):** [`copy_sqlite`] uses the online backup API, so a
//!   consistent snapshot comes out even while signal-cli still has the
//!   database open and writing, folding in any WAL content. It backs up
//!   into a temp file inside the vault dir and deletes it on every path,
//!   including an error, via [`TempFileGuard`] — the only plaintext ever
//!   allowed to touch the vault directory.
//! - **Everything else:** [`copy_locked`] takes a shared OFD `fcntl` lock —
//!   the same kind `java.nio.channels.FileChannel.lock` takes on Linux, so
//!   the two interoperate — copies the file, releases the lock, then, if the
//!   content looks like JSON, checks that it actually parses.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Why a single copy attempt didn't produce bytes. Always a reason to
/// retry, never a hard failure by itself — `sync` retries up to 3 times with
/// backoff and only then gives up and skips the file for this round.
#[derive(Debug)]
pub(crate) enum Retry {
    LockTimeout,
    InvalidJson,
    Io(String),
}

impl std::fmt::Display for Retry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Retry::LockTimeout => write!(f, "timed out waiting for a shared lock"),
            Retry::InvalidJson => write!(f, "copy didn't parse as valid JSON"),
            Retry::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Deletes its path on drop, on every path out of the function that creates
/// it — a plain `?` early return included. The SQLite backup temp file is
/// the one plaintext file ever allowed to exist in the vault directory, and
/// only transiently.
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn random_suffix() -> u64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    u64::from_le_bytes(bytes)
}

/// The temp-file naming convention [`copy_sqlite`] uses, so a leftover from
/// a hard crash (no chance for `TempFileGuard::drop` to run) is recognizable
/// as a stray file during `gc`, rather than mistaken for vault state.
pub(crate) const SQLITE_TMP_PREFIX: &str = ".sqlite-backup-";

fn sqlite_tmp_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join(format!("{SQLITE_TMP_PREFIX}{}-{}.tmp", std::process::id(), random_suffix()))
}

/// Backs an SQLite database at `path` up through the online backup API into
/// a fresh temp file inside `vault_dir`, reads the result back, and deletes
/// the temp file. `-wal`/`-shm` sidecars are never read directly: the backup
/// API folds any WAL content into the single `.db` snapshot itself.
pub(crate) fn copy_sqlite(path: &Path, vault_dir: &Path) -> Result<Vec<u8>, Retry> {
    let tmp_path = sqlite_tmp_path(vault_dir);
    let _guard = TempFileGuard(tmp_path.clone());

    let src = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| Retry::Io(format!("vault: couldn't open {} for backup: {e}", path.display())))?;
    let mut dst = rusqlite::Connection::open(&tmp_path).map_err(|e| Retry::Io(format!("vault: couldn't create a backup target: {e}")))?;
    {
        let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| Retry::Io(format!("vault: couldn't start a SQLite backup: {e}")))?;
        backup
            .run_to_completion(64, Duration::from_millis(10), None)
            .map_err(|e| Retry::Io(format!("vault: SQLite backup of {} failed: {e}", path.display())))?;
    }
    drop(dst);
    drop(src);

    fs::read(&tmp_path).map_err(|e| Retry::Io(format!("vault: couldn't read the backup copy: {e}")))
    // `_guard` removes `tmp_path` here, whichever way this function returns.
}

fn looks_like_json(buf: &[u8]) -> bool {
    matches!(buf.iter().find(|b| !b.is_ascii_whitespace()), Some(b'{') | Some(b'['))
}

/// Takes a shared OFD lock on `path`, copies its contents, releases the
/// lock, then — only if the content looks like JSON (first non-whitespace
/// byte is `{` or `[`) — checks that it actually parses.
pub(crate) fn copy_locked(path: &Path) -> Result<Vec<u8>, Retry> {
    let file = fs::File::open(path).map_err(|e| Retry::Io(e.to_string()))?;
    lock_shared(&file)?;
    let mut buf = Vec::new();
    let read_result = (&file).read_to_end(&mut buf);
    unlock(&file);
    read_result.map_err(|e| Retry::Io(e.to_string()))?;

    if looks_like_json(&buf) && serde_json::from_slice::<serde_json::Value>(&buf).is_err() {
        return Err(Retry::InvalidJson);
    }
    Ok(buf)
}

/// OFD (`F_OFD_SETLK`) record locks: Linux-only, and the one the whole vault
/// is scoped to (docs/ENCRYPTION.md: the runtime dir only exists where a
/// RAM-backed directory is available, which today means Linux). Elsewhere,
/// there's nothing to interoperate with signal-cli's own `FileChannel.lock`
/// over, so locking is a no-op; the JSON parse check still applies.
#[cfg(target_os = "linux")]
fn lock_shared(file: &fs::File) -> Result<(), Retry> {
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_RDLCK as libc::c_short;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    lock.l_start = 0;
    lock.l_len = 0; // whole file

    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    let mut backoff = Duration::from_millis(5);
    loop {
        let rc = unsafe { libc::fcntl(fd, libc::F_OFD_SETLK, &lock) };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        let would_block = matches!(err.raw_os_error(), Some(libc::EACCES) | Some(libc::EAGAIN));
        if !would_block {
            return Err(Retry::Io(err.to_string()));
        }
        if std::time::Instant::now() >= deadline {
            return Err(Retry::LockTimeout);
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_millis(50));
    }
}

#[cfg(target_os = "linux")]
fn unlock(file: &fs::File) {
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_UNLCK as libc::c_short;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    lock.l_start = 0;
    lock.l_len = 0;
    unsafe {
        libc::fcntl(fd, libc::F_OFD_SETLK, &lock);
    }
}

#[cfg(not(target_os = "linux"))]
fn lock_shared(_file: &fs::File) -> Result<(), Retry> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn unlock(_file: &fs::File) {}

/// Removes any leftover SQLite backup temp file in `vault_dir` — only
/// possible after a hard crash, since [`TempFileGuard`] deletes it on every
/// normal return path.
pub(crate) fn gc_stray_tmp(vault_dir: &Path) -> Result<usize, crate::error::Error> {
    let entries = match fs::read_dir(vault_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(super::io_err(vault_dir, e)),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| super::io_err(vault_dir, e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(SQLITE_TMP_PREFIX) && name.ends_with(".tmp") {
            fs::remove_file(entry.path()).map_err(|e| super::io_err(&entry.path(), e))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-copy-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    #[test]
    fn copy_locked_round_trips_plain_bytes() {
        let dir = temp_dir("plain");
        let dir = dir.path();
        let path = dir.join("a.txt");
        fs::write(&path, b"not json at all").unwrap();
        assert_eq!(copy_locked(&path).unwrap(), b"not json at all");
    }

    #[test]
    fn copy_locked_accepts_valid_json() {
        let dir = temp_dir("valid-json");
        let dir = dir.path();
        let path = dir.join("a.json");
        fs::write(&path, br#"  { "a": 1 }  "#).unwrap();
        assert_eq!(copy_locked(&path).unwrap(), br#"  { "a": 1 }  "#);
    }

    #[test]
    fn copy_locked_rejects_invalid_json() {
        let dir = temp_dir("invalid-json");
        let dir = dir.path();
        let path = dir.join("a.json");
        fs::write(&path, b"{ not valid").unwrap();
        assert!(matches!(copy_locked(&path), Err(Retry::InvalidJson)));
    }

    #[test]
    fn copy_locked_ignores_array_json_too() {
        let dir = temp_dir("array-json");
        let dir = dir.path();
        let path = dir.join("a.json");
        fs::write(&path, b"[1, 2, 3]").unwrap();
        assert_eq!(copy_locked(&path).unwrap(), b"[1, 2, 3]");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_shared_lock_from_another_thread_does_not_block_us() {
        let dir = temp_dir("shared-ok");
        let dir = dir.path();
        let path = dir.join("a.txt");
        fs::write(&path, b"shared readers are fine").unwrap();
        let other = fs::File::open(&path).unwrap();
        lock_shared(&other).unwrap(); // another shared (read) lock holder
        assert_eq!(copy_locked(&path).unwrap(), b"shared readers are fine");
        unlock(&other);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn waits_out_a_brief_exclusive_lock_then_succeeds() {
        use std::os::unix::io::AsRawFd;
        let dir = temp_dir("wait-exclusive");
        let dir = dir.path();
        let path = dir.join("a.txt");
        fs::write(&path, b"content after the writer lets go").unwrap();

        let holder = fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        let fd = holder.as_raw_fd();
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK as libc::c_short;
        lock.l_whence = libc::SEEK_SET as libc::c_short;
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_OFD_SETLK, &lock) }, 0);

        let path_clone = path.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let mut unlock_req = lock;
            unlock_req.l_type = libc::F_UNLCK as libc::c_short;
            unsafe { libc::fcntl(fd, libc::F_OFD_SETLK, &unlock_req) };
            drop(holder);
            let _ = path_clone;
        });

        let bytes = copy_locked(&path).unwrap();
        assert_eq!(bytes, b"content after the writer lets go");
        handle.join().unwrap();
    }

    #[test]
    fn gc_stray_tmp_removes_leftover_backup_files_only() {
        let dir = temp_dir("stray");
        let dir = dir.path();
        fs::write(dir.join(format!("{SQLITE_TMP_PREFIX}1234-5678.tmp")), b"x").unwrap();
        fs::write(dir.join("manifest"), b"keep").unwrap();
        let removed = gc_stray_tmp(dir).unwrap();
        assert_eq!(removed, 1);
        assert!(dir.join("manifest").exists());
    }
}
