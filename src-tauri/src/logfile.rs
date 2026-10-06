//! A small append-only log with one rotation (`<name>` → `<name>.1` past
//! `MAX_BYTES`). Used by [`crate::applog`] for `snowdrop.log`, the one log
//! file the whole app writes to.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct LogFile {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    path: PathBuf,
    written: u64,
}

impl LogFile {
    pub fn new(path: PathBuf) -> Self {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let written = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { inner: Arc::new(Mutex::new(Inner { path, written })) }
    }

    pub fn append(&self, line: &str) {
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.written > MAX_BYTES {
            let mut rotated = inner.path.clone().into_os_string();
            rotated.push(".1");
            let _ = fs::rename(&inner.path, rotated);
            inner.written = 0;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        // Only applies when the file is newly created; signal-cli's stderr
        // may mention account details, so it's as private as the data dir.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&inner.path) {
            if writeln!(file, "{line}").is_ok() {
                inner.written += line.len() as u64 + 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_rotates() {
        // Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
        let dir = tempfile::Builder::new().prefix(&format!("snowdrop-log-test-{}-", std::process::id())).tempdir().unwrap();
        let log = LogFile::new(dir.path().join("signal-cli.log"));
        log.append("first");
        assert_eq!(fs::read_to_string(dir.path().join("signal-cli.log")).unwrap(), "first\n");
        log.inner.lock().unwrap().written = MAX_BYTES + 1;
        log.append("second");
        assert_eq!(fs::read_to_string(dir.path().join("signal-cli.log")).unwrap(), "second\n");
        assert_eq!(fs::read_to_string(dir.path().join("signal-cli.log.1")).unwrap(), "first\n");
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_log_file_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::Builder::new().prefix(&format!("snowdrop-log-mode-test-{}-", std::process::id())).tempdir().unwrap();
        let path = dir.path().join("signal-cli.log");
        LogFile::new(path.clone()).append("hello");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
