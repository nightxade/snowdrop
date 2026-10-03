//! A small append-only log with one rotation (`signal-cli.log` →
//! `signal-cli.log.1` past `MAX_BYTES`), for signal-cli's stderr.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

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
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&inner.path) {
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
        let dir = std::env::temp_dir().join(format!("snowdrop-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = LogFile::new(dir.join("signal-cli.log"));
        log.append("first");
        assert_eq!(fs::read_to_string(dir.join("signal-cli.log")).unwrap(), "first\n");
        log.inner.lock().unwrap().written = MAX_BYTES + 1;
        log.append("second");
        assert_eq!(fs::read_to_string(dir.join("signal-cli.log")).unwrap(), "second\n");
        assert_eq!(fs::read_to_string(dir.join("signal-cli.log.1")).unwrap(), "first\n");
    }
}
