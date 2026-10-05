//! What the UI may configure, and the checks that keep it from becoming an
//! arbitrary command runner: the only program ever started is a file named
//! `signal-cli` (the bundled sidecar, a configured absolute path, or one on
//! PATH), always with arguments built here; accounts and daemon URLs are
//! validated before use.

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use crate::error::{Error, ErrorKind};

/// How the desktop app reaches signal-cli (sent by the UI on connect).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ConnectConfig {
    /// Snowdrop runs `signal-cli jsonRpc` as a child process (the default).
    #[serde(rename_all = "camelCase")]
    Spawn {
        /// A signal-cli the user installed: an absolute path, or empty to use
        /// whatever `resolve_binary` finds (the downloaded install, then a
        /// bundled sidecar in a bundled build, then PATH).
        #[serde(default)]
        binary_path: Option<String>,
        /// Run signal-cli for this account only (`-a`); empty = multi-account.
        #[serde(default)]
        account: Option<String>,
    },
    /// A signal-cli HTTP daemon the user runs (`daemon --http`), on this machine.
    #[serde(rename_all = "camelCase")]
    External { url: String },
}

/// Where the program came from (shown in Settings → Connection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BinarySource {
    Configured,
    /// Downloaded into the app data dir on first launch (signal_cli_install.rs).
    Downloaded,
    /// A sidecar shipped inside the app package (only in a `bundled-sidecar` build).
    Bundled,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBinary {
    pub path: PathBuf,
    pub source: BinarySource,
}

pub const INSTALL_HINT: &str = "Install signal-cli (https://github.com/AsamK/signal-cli/releases; the Linux-native build needs no Java), then set its path in Settings → Connection, or use a Snowdrop build that bundles it.";

/// The file name a signal-cli executable must have (`signal-cli`, `signal-cli.exe`, `signal-cli.bat`).
fn is_signal_cli_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    matches!(name.as_ref(), "signal-cli" | "signal-cli.exe" | "signal-cli.bat")
}

#[cfg(unix)]
pub(crate) fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
pub(crate) fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Restricts a directory to its owner (unix `0700`): Snowdrop's app data dir
/// and signal-cli's own data dir hold a linked account's keys and message
/// history, which no other local account should be able to read. Called
/// every time the directory is touched, not only when it's first created, so
/// an install made before this existed gets fixed too.
#[cfg(unix)]
pub(crate) fn secure_dir(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = path
        .metadata()
        .map_err(|e| Error::new(ErrorKind::Internal, format!("Couldn't read {}: {e}", path.display())))?
        .permissions();
    perm.set_mode(0o700);
    std::fs::set_permissions(path, perm)
        .map_err(|e| Error::new(ErrorKind::Internal, format!("Couldn't secure {}: {e}", path.display())))
}

#[cfg(not(unix))]
pub(crate) fn secure_dir(_path: &Path) -> Result<(), Error> {
    Ok(())
}

/// Validates a configured path: absolute, named signal-cli, an executable file.
pub fn validate_binary_path(raw: &str) -> Result<PathBuf, Error> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err(Error::new(ErrorKind::Config, "The signal-cli path must be absolute (for example /usr/local/bin/signal-cli)."));
    }
    if !path.file_name().is_some_and(is_signal_cli_name) {
        return Err(Error::new(ErrorKind::Config, "The path must point to the signal-cli program itself (a file named signal-cli)."));
    }
    let resolved = path.canonicalize().map_err(|_| {
        Error::new(ErrorKind::NotInstalled, format!("No signal-cli at {}. {INSTALL_HINT}", path.display()))
    })?;
    // A symlink must lead to signal-cli too (not, say, a shell).
    if !resolved.file_name().is_some_and(is_signal_cli_name) {
        return Err(Error::new(ErrorKind::Config, format!("{} doesn't lead to a program named signal-cli.", path.display())));
    }
    if !is_executable(&resolved) {
        return Err(Error::new(ErrorKind::Config, format!("{} isn't an executable file.", path.display())));
    }
    Ok(path)
}

/// Finds `signal-cli` on a PATH-style list of directories.
pub fn find_on_path(path_var: Option<&OsStr>) -> Option<PathBuf> {
    let dirs = std::env::split_paths(path_var?).collect::<Vec<_>>();
    for dir in dirs {
        for name in ["signal-cli", "signal-cli.exe", "signal-cli.bat"] {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolution order: a user-configured path, then the version Snowdrop
/// downloaded into the app data dir on first launch, then (only in a build
/// with the `bundled-sidecar` Cargo feature) the sidecar shipped inside the
/// app package, then `signal-cli` on PATH.
pub fn resolve_binary(
    configured: Option<&str>,
    downloaded: Option<&Path>,
    bundled: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Result<ResolvedBinary, Error> {
    if let Some(raw) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(ResolvedBinary { path: validate_binary_path(raw)?, source: BinarySource::Configured });
    }
    if let Some(path) = downloaded.filter(|p| is_executable(p)) {
        return Ok(ResolvedBinary { path: path.to_path_buf(), source: BinarySource::Downloaded });
    }
    if let Some(path) = bundled.filter(|p| is_executable(p)) {
        return Ok(ResolvedBinary { path: path.to_path_buf(), source: BinarySource::Bundled });
    }
    find_on_path(path_var)
        .map(|path| ResolvedBinary { path, source: BinarySource::Path })
        .ok_or_else(|| Error::new(ErrorKind::NotInstalled, format!("signal-cli wasn't found. {INSTALL_HINT}")))
}

/// The sidecar Tauri installs next to the app's executable (`externalBin`).
/// Only present in a build with the `bundled-sidecar` feature
/// (`npm run tauri:build:bundled`): the default build has no sidecar at all.
#[cfg(feature = "bundled-sidecar")]
pub fn bundled_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let path = dir.join(if cfg!(windows) { "signal-cli.exe" } else { "signal-cli" });
    is_executable(&path).then_some(path)
}

#[cfg(not(feature = "bundled-sidecar"))]
pub fn bundled_sidecar() -> Option<PathBuf> {
    None
}

/// A phone number in E.164 form or an ACI (UUID).
pub fn validate_account(raw: &str) -> Result<String, Error> {
    let account = raw.trim();
    let phone = account.len() >= 4
        && account.len() <= 20
        && account.starts_with('+')
        && account[1..].chars().all(|c| c.is_ascii_digit());
    let uuid = account.len() == 36
        && account.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    if phone || uuid {
        Ok(account.to_owned())
    } else {
        Err(Error::new(ErrorKind::Config, "The account must be a phone number in international form (+44…) or an ACI."))
    }
}

/// The fixed command line for a managed signal-cli. Nothing from the UI
/// reaches it except an account that passed `validate_account`.
pub fn spawn_args(config_dir: &Path, account: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--config".into(), config_dir.as_os_str().to_owned()];
    if let Some(account) = account {
        args.push("-a".into());
        args.push(account.into());
    }
    args.push("jsonRpc".into());
    // Receive only once the UI subscribes, so nothing arrives unheard.
    args.push("--receive-mode=manual".into());
    args
}

/// A parsed external daemon URL: `http://<loopback>[:port][/base]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonUrl {
    /// e.g. `http://127.0.0.1:8080` (no trailing slash).
    pub base: String,
}

/// Only plain HTTP on a loopback address: the daemon has no authentication,
/// and everything stays on this machine.
pub fn validate_daemon_url(raw: &str) -> Result<DaemonUrl, Error> {
    let bad = |m: &str| Error::new(ErrorKind::Config, m.to_owned());
    let url = raw.trim().trim_end_matches('/');
    let rest = url.strip_prefix("http://").ok_or_else(|| bad("The daemon address must start with http:// (signal-cli's HTTP daemon has no TLS)."))?;
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.contains('@') {
        return Err(bad("The daemon address can't contain credentials."));
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split_once(']').map(|(h, _)| h).ok_or_else(|| bad("That daemon address isn't valid."))?
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    if let Some((_, port)) = authority.rsplit_once(':').filter(|_| !authority.ends_with(']')) {
        if !port.is_empty() && port.parse::<u16>().is_err() {
            return Err(bad("That port isn't valid."));
        }
    }
    let is_localhost = host.eq_ignore_ascii_case("localhost");
    let loopback = is_localhost || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        return Err(bad("Snowdrop only connects to a signal-cli daemon on this computer (127.0.0.1, ::1 or localhost)."));
    }
    if path.chars().any(|c| c.is_whitespace() || c == '?' || c == '#') {
        return Err(bad("That daemon address isn't valid."));
    }
    // "localhost" isn't trusted as-is: a misconfigured resolver or
    // `/etc/hosts` entry could in principle point it somewhere that isn't
    // loopback, and every connection is built from `base` afterwards. Pin it
    // to the literal loopback address now, before anything ever resolves it.
    let base = if is_localhost {
        format!("http://{}{}", authority.replacen(host, "127.0.0.1", 1), if path.is_empty() { String::new() } else { format!("/{path}") })
    } else {
        url.to_owned()
    };
    Ok(DaemonUrl { base })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-config-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    #[cfg(unix)]
    fn make_exec(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_configured_then_downloaded_then_bundled_then_path() {
        let dir = temp_dir("resolve");
        let dir = dir.path();
        let configured = dir.join("configured").join("signal-cli");
        let downloaded = dir.join("downloaded").join("signal-cli");
        let bundled = dir.join("bundled").join("signal-cli");
        let on_path = dir.join("onpath").join("signal-cli");
        for p in [&configured, &downloaded, &bundled, &on_path] {
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            make_exec(p);
        }
        let path_var = std::env::join_paths([on_path.parent().unwrap()]).unwrap();
        let cfg = configured.to_str().unwrap();

        // Configured beats everything else.
        let r = resolve_binary(Some(cfg), Some(&downloaded), Some(&bundled), Some(&path_var)).unwrap();
        assert_eq!((r.source, r.path), (BinarySource::Configured, configured.clone()));
        // No configured path: the downloaded install beats the bundled sidecar.
        let r = resolve_binary(None, Some(&downloaded), Some(&bundled), Some(&path_var)).unwrap();
        assert_eq!((r.source, r.path), (BinarySource::Downloaded, downloaded.clone()));
        // No downloaded install: the bundled sidecar beats PATH.
        let r = resolve_binary(None, None, Some(&bundled), Some(&path_var)).unwrap();
        assert_eq!((r.source, r.path), (BinarySource::Bundled, bundled.clone()));
        // Nothing else: PATH.
        let r = resolve_binary(None, None, None, Some(&path_var)).unwrap();
        assert_eq!((r.source, r.path), (BinarySource::Path, on_path));
        let missing = resolve_binary(Some(""), None, None, Some(OsStr::new(""))).unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotInstalled);
        assert!(missing.message.contains("Install signal-cli"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_paths_that_are_not_signal_cli() {
        let dir = temp_dir("validate");
        let dir = dir.path();
        let shell = dir.join("sh");
        make_exec(&shell);
        assert_eq!(validate_binary_path(shell.to_str().unwrap()).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(validate_binary_path("signal-cli").unwrap_err().kind, ErrorKind::Config);
        assert_eq!(validate_binary_path("/nonexistent/signal-cli").unwrap_err().kind, ErrorKind::NotInstalled);
        let not_exec = dir.join("signal-cli");
        fs::write(&not_exec, "x").unwrap();
        assert_eq!(validate_binary_path(not_exec.to_str().unwrap()).unwrap_err().kind, ErrorKind::Config);
        make_exec(&not_exec);
        assert!(validate_binary_path(not_exec.to_str().unwrap()).is_ok());
    }

    #[test]
    fn builds_fixed_arguments() {
        let args = spawn_args(Path::new("/data/sc"), None);
        assert_eq!(args, ["--config", "/data/sc", "jsonRpc", "--receive-mode=manual"].map(OsString::from));
        let args = spawn_args(Path::new("/data/sc"), Some("+15550001"));
        assert_eq!(args[2..4], ["-a", "+15550001"].map(OsString::from));
    }

    #[test]
    fn validates_accounts() {
        assert!(validate_account("+447700900123").is_ok());
        assert!(validate_account("11111111-1111-4111-8111-111111111111").is_ok());
        for bad in ["", "447700900123", "+44 7700", "--help", "+1;rm", "11111111-1111-4111-8111-11111111111g"] {
            assert!(validate_account(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_accepts_loopback_http_daemons() {
        assert_eq!(validate_daemon_url("http://127.0.0.1:8080/").unwrap().base, "http://127.0.0.1:8080");
        assert!(validate_daemon_url("http://localhost:8080").is_ok());
        assert!(validate_daemon_url("http://[::1]:8080").is_ok());
        assert!(validate_daemon_url("http://127.0.0.2").is_ok());
        for bad in [
            "https://127.0.0.1:8080",
            "http://example.com:8080",
            "http://192.168.1.2:8080",
            "http://user:pw@127.0.0.1:8080",
            "http://127.0.0.1:99999",
            "ftp://127.0.0.1",
            "http://127.0.0.1.example.com",
        ] {
            assert!(validate_daemon_url(bad).is_err(), "{bad}");
        }
    }

    /// "localhost" is never trusted to resolve correctly on its own — it's
    /// pinned to the literal loopback address before anything connects, so a
    /// hijacked resolver or `/etc/hosts` entry can't send it anywhere else.
    #[test]
    fn normalises_localhost_to_the_loopback_address() {
        assert_eq!(validate_daemon_url("http://localhost:8080").unwrap().base, "http://127.0.0.1:8080");
        assert_eq!(validate_daemon_url("http://localhost").unwrap().base, "http://127.0.0.1");
        assert_eq!(validate_daemon_url("http://LOCALHOST:8080").unwrap().base, "http://127.0.0.1:8080");
        assert_eq!(validate_daemon_url("http://localhost:8080/v1").unwrap().base, "http://127.0.0.1:8080/v1");
        // A real loopback IP address is left exactly as given.
        assert_eq!(validate_daemon_url("http://127.0.0.2:8080").unwrap().base, "http://127.0.0.2:8080");
        assert_eq!(validate_daemon_url("http://[::1]:8080").unwrap().base, "http://[::1]:8080");
    }

    #[test]
    fn parses_ui_config() {
        let spawn: ConnectConfig = serde_json::from_str(r#"{"mode":"spawn","binaryPath":null}"#).unwrap();
        assert_eq!(spawn, ConnectConfig::Spawn { binary_path: None, account: None });
        let external: ConnectConfig = serde_json::from_str(r#"{"mode":"external","url":"http://127.0.0.1:8080"}"#).unwrap();
        assert_eq!(external, ConnectConfig::External { url: "http://127.0.0.1:8080".into() });
        assert!(serde_json::from_str::<ConnectConfig>(r#"{"mode":"shell","cmd":"rm"}"#).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn secure_dir_locks_a_directory_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("secure-new");
        let dir = dir.path();
        // Freshly created directories are rarely 0700 by default (umask).
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
        secure_dir(dir).unwrap();
        assert_eq!(dir.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }

    /// An install made before this existed may have a world- or group-
    /// readable data dir; `secure_dir` must fix it, not just set it at
    /// creation time.
    #[cfg(unix)]
    #[test]
    fn secure_dir_fixes_a_directory_left_over_from_an_earlier_install() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("secure-existing");
        let dir = dir.path();
        fs::set_permissions(dir, fs::Permissions::from_mode(0o777)).unwrap();
        secure_dir(dir).unwrap();
        assert_eq!(dir.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }
}
