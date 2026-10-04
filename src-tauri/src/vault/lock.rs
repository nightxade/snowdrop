//! The single-instance lock (docs/ENCRYPTION.md, "Restore", step 1):
//! `<app data>/snowdrop.lock`, taken exclusively and non-blocking so a
//! second Snowdrop instance fails fast instead of waiting on the first.
//!
//! This is a plain per-process `flock`, deliberately not the OFD `fcntl`
//! lock `copy.rs` uses for signal-cli's own files: `copy.rs` wants to
//! interoperate with `FileChannel.lock`'s per-open-file-description
//! semantics, while this lock only ever needs to ask "is some process
//! already holding this file open", which `flock` answers directly.

use std::fs;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::Path;

use crate::error::{Error, ErrorKind};

use super::{create_secure_dir, io_err};

const LOCK_FILE_NAME: &str = "snowdrop.lock";

/// An exclusive, non-blocking hold on `<app data>/snowdrop.lock`. Held for
/// as long as this value lives: dropping it (including an ordinary panic
/// unwind or process exit) closes the underlying file descriptor, which the
/// kernel always treats as releasing the `flock`.
#[derive(Debug)]
pub struct InstanceLock {
    _file: fs::File,
}

impl InstanceLock {
    /// Acquires the lock, creating `app_data_dir` (mode `0700`) if needed.
    /// Never blocks: if another process (or, within one process, another
    /// open file description — see the tests below) already holds it, this
    /// returns [`ErrorKind::AlreadyRunning`] immediately.
    pub fn acquire(app_data_dir: &Path) -> Result<Self, Error> {
        create_secure_dir(app_data_dir)?;
        let path = app_data_dir.join(LOCK_FILE_NAME);
        let file =
            fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(&path).map_err(|e| io_err(&path, e))?;

        let fd = file.as_raw_fd();
        // SAFETY: `fd` is a valid, open file descriptor owned by `file` for
        // the duration of this call.
        let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if matches!(err.raw_os_error(), Some(libc::EWOULDBLOCK)) {
                return Err(Error::new(ErrorKind::AlreadyRunning, "Snowdrop is already running (another instance holds snowdrop.lock)."));
            }
            return Err(io_err(&path, err));
        }
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-vault-lock-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_acquisition_succeeds() {
        let dir = temp_dir("first");
        let _lock = InstanceLock::acquire(&dir).unwrap();
        assert!(dir.join(LOCK_FILE_NAME).exists());
    }

    /// `flock` is scoped per *open file description*, not per process or per
    /// inode: two separate `open()` calls on the same path — exactly what
    /// two `acquire` calls produce — contend with each other even from the
    /// same process, which is what makes this test meaningful.
    #[test]
    fn a_second_acquisition_with_the_first_still_held_fails() {
        let dir = temp_dir("contended");
        let _first = InstanceLock::acquire(&dir).unwrap();
        let err = InstanceLock::acquire(&dir).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AlreadyRunning);
    }

    #[test]
    fn the_lock_is_released_on_drop() {
        let dir = temp_dir("released");
        {
            let _first = InstanceLock::acquire(&dir).unwrap();
        }
        // The first lock's fd closed when it dropped, releasing the flock.
        let _second = InstanceLock::acquire(&dir).unwrap();
    }

    #[test]
    fn three_sequential_contentions_all_fail_while_held() {
        let dir = temp_dir("triple");
        let _held = InstanceLock::acquire(&dir).unwrap();
        for _ in 0..3 {
            assert_eq!(InstanceLock::acquire(&dir).unwrap_err().kind, ErrorKind::AlreadyRunning);
        }
    }
}
