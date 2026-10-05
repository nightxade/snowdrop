//! Resolves the RAM-backed signal-cli runtime dir (docs/ENCRYPTION.md,
//! "signal-cli vault"): `$XDG_RUNTIME_DIR/snowdrop/signal-cli` on Linux,
//! after confirming `XDG_RUNTIME_DIR` itself is owned by this process's uid,
//! mode `0700`, and backed by tmpfs or ramfs. Anything else — the variable
//! unset, wrong owner or mode, a disk-backed filesystem, or any non-Linux
//! platform — returns [`ErrorKind::NoRamDir`]. Snowdrop never falls back to
//! a disk path for signal-cli's plaintext keys.

use std::io;
use std::path::{Path, PathBuf};

use crate::error::{Error, ErrorKind};

use super::create_secure_dir;

/// `linux/statfs.h`: `f_type` of a tmpfs mount.
pub const TMPFS_MAGIC: i64 = 0x0102_1994;
/// `linux/magic.h`: `f_type` of a ramfs mount.
pub const RAMFS_MAGIC: i64 = 0x8584_58f6;

const ENV_XDG_RUNTIME_DIR: &str = "XDG_RUNTIME_DIR";

fn no_ram_dir(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::NoRamDir, message.into())
}

/// Resolves and creates (mode `0700`) `$XDG_RUNTIME_DIR/snowdrop/signal-cli`
/// on Linux. Every other platform has no RAM-backed directory to offer yet,
/// so it's [`ErrorKind::NoRamDir`] unconditionally.
#[cfg(target_os = "linux")]
pub fn resolve() -> Result<PathBuf, Error> {
    resolve_with(std::env::var_os(ENV_XDG_RUNTIME_DIR).map(PathBuf::from), statfs_magic)
}

#[cfg(not(target_os = "linux"))]
pub fn resolve() -> Result<PathBuf, Error> {
    Err(no_ram_dir(
        "No RAM-backed runtime directory is available on this platform yet, so the signal-cli vault can't be used (docs/ENCRYPTION.md, \"signal-cli vault\").",
    ))
}

/// The logic behind [`resolve`], with the environment variable and the
/// filesystem-type check both passed in so tests can run without a real
/// `XDG_RUNTIME_DIR` or a real tmpfs mount.
pub(crate) fn resolve_with(xdg_runtime_dir: Option<PathBuf>, fs_magic: impl Fn(&Path) -> io::Result<i64>) -> Result<PathBuf, Error> {
    let base = xdg_runtime_dir.ok_or_else(|| {
        no_ram_dir(
            "XDG_RUNTIME_DIR isn't set. Snowdrop needs the per-user runtime directory \
             (normally provided by systemd-logind or elogind) to run signal-cli without \
             ever writing its plaintext keys to disk.",
        )
    })?;

    validate_base(&base)?;

    let magic = fs_magic(&base).map_err(|e| no_ram_dir(format!("couldn't check the filesystem of {}: {e}", base.display())))?;
    if magic != TMPFS_MAGIC && magic != RAMFS_MAGIC {
        return Err(no_ram_dir(format!(
            "{} isn't backed by tmpfs or ramfs (filesystem type {magic:#x}). Snowdrop won't use a disk-backed directory for signal-cli's plaintext keys.",
            base.display()
        )));
    }

    let snowdrop_dir = base.join("snowdrop");
    create_secure_dir(&snowdrop_dir)?;
    let dir = snowdrop_dir.join("signal-cli");
    create_secure_dir(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn validate_base(base: &Path) -> Result<(), Error> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = std::fs::metadata(base).map_err(|e| no_ram_dir(format!("couldn't check {}: {e}", base.display())))?;
    if !meta.is_dir() {
        return Err(no_ram_dir(format!("{} isn't a directory.", base.display())));
    }
    // SAFETY: getuid takes no arguments and can't fail.
    let current_uid = unsafe { libc::getuid() };
    if meta.uid() != current_uid {
        return Err(no_ram_dir(format!("{} isn't owned by this user.", base.display())));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(no_ram_dir(format!("{} must be mode 0700 (found {mode:03o}).", base.display())));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_base(base: &Path) -> Result<(), Error> {
    Err(no_ram_dir(format!("{} can't be validated as a RAM-backed directory on this platform.", base.display())))
}

/// The real filesystem-type check, via `statfs(2)`. Linux-only: it's only
/// ever called from [`resolve`], which is itself Linux-only.
#[cfg(target_os = "linux")]
fn statfs_magic(path: &Path) -> io::Result<i64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    // SAFETY: `buf` is a valid, zeroed `statfs` the kernel fills in; `c_path`
    // is a valid NUL-terminated C string for the duration of the call.
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buf.f_type as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        let dir = tempfile::Builder::new().prefix(&format!("snowdrop-vault-runtime-test-{}-{name}-", std::process::id())).tempdir().unwrap();
        let mut perm = fs::metadata(dir.path()).unwrap().permissions();
        perm.set_mode(0o700);
        fs::set_permissions(dir.path(), perm).unwrap();
        dir
    }

    fn always(magic: i64) -> impl Fn(&Path) -> io::Result<i64> {
        move |_| Ok(magic)
    }

    #[test]
    fn missing_env_var_is_no_ram_dir() {
        let err = resolve_with(None, always(TMPFS_MAGIC)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NoRamDir);
    }

    #[test]
    fn disk_backed_filesystem_is_rejected() {
        let base = temp_dir("disk-backed");
        // A made-up magic that isn't tmpfs or ramfs: simulates an ordinary
        // disk filesystem without depending on the test host's real /tmp.
        let err = resolve_with(Some(base.path().to_path_buf()), always(0x1234_5678)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NoRamDir);
    }

    #[test]
    fn tmpfs_and_ramfs_are_both_accepted() {
        for magic in [TMPFS_MAGIC, RAMFS_MAGIC] {
            let base = temp_dir(&format!("accepted-{magic:x}"));
            let dir = resolve_with(Some(base.path().to_path_buf()), always(magic)).unwrap();
            assert_eq!(dir, base.path().join("snowdrop").join("signal-cli"));
            assert!(dir.is_dir());
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(base.path().join("snowdrop")).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn wrong_mode_is_rejected() {
        let base = temp_dir("wrong-mode");
        let mut perm = fs::metadata(&base).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&base, perm).unwrap();
        let err = resolve_with(Some(base.path().to_path_buf()), always(TMPFS_MAGIC)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NoRamDir);
    }

    #[test]
    fn nonexistent_base_is_rejected() {
        let base = std::env::temp_dir().join("snowdrop-vault-runtime-test-does-not-exist");
        let _ = fs::remove_dir_all(&base);
        let err = resolve_with(Some(base), always(TMPFS_MAGIC)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NoRamDir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn statfs_magic_reads_a_real_filesystem() {
        // Whatever /tmp is backed by, the call itself must succeed and
        // return a plausible, nonzero magic number.
        let magic = statfs_magic(&std::env::temp_dir()).unwrap();
        assert_ne!(magic, 0);
    }
}
