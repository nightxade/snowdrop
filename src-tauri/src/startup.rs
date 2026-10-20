//! Startup: phase timing, and the record of the last signal-cli connection
//! that lets the app start signal-cli before the webview asks for it
//! (`Service::prespawn`).
//!
//! Timing is names and elapsed milliseconds only, at `info` (visible with
//! `SNOWDROP_LOG=info`): never a path, id, account or any message data. The
//! frontend logs its own phases the same way (scope `startup`,
//! `src/core/lib/startup.ts`), so the two can be laid side by side.
//!
//! The record (`last-connect.json` in the app data dir) holds nothing secret:
//! the custom binary path the user already configured, and whether an
//! account was linked the last time signal-cli answered. An account number
//! is deliberately never written — a connect that names one clears the
//! record instead, so such a setup simply starts signal-cli on request, as
//! before.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::config::ConnectConfig;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Starts the clock; the first call wins. Call it at the top of `run()`.
pub fn begin() {
    let _ = PROCESS_START.set(Instant::now());
    mark_once("process start");
}

/// Logs `phase` with the time since [`begin`] (0 ms if it was never called).
pub fn mark(phase: &'static str) {
    let ms = PROCESS_START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    log::info!(target: "rust:startup", "{phase} at {ms} ms");
}

/// [`mark`], only the first time this phase is reached in the process.
pub fn mark_once(phase: &'static str) {
    {
        let mut seen = SEEN.lock().expect("startup marks lock");
        if seen.contains(&phase) {
            return;
        }
        seen.push(phase);
    }
    mark(phase);
}

/// What was true the last time signal-cli answered in spawn mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastConnect {
    #[serde(default)]
    pub binary_path: Option<String>,
    /// signal-cli reported at least one account.
    pub linked: bool,
}

impl LastConnect {
    /// The config worth starting signal-cli with ahead of the frontend: only
    /// once an account is known to be linked.
    pub fn prespawn_config(&self) -> Option<ConnectConfig> {
        self.linked.then(|| ConnectConfig::Spawn { binary_path: self.binary_path.clone(), account: None })
    }

    /// The record a successful connect with `config` leaves, given the one
    /// before it. Only spawn mode with no named account is recorded (`None`
    /// otherwise: the caller clears the record); `linked` carries over.
    pub fn after_connect(previous: Option<&LastConnect>, config: &ConnectConfig) -> Option<LastConnect> {
        match config {
            ConnectConfig::Spawn { binary_path, account: None } => Some(LastConnect {
                binary_path: binary_path.clone(),
                linked: previous.is_some_and(|p| p.linked),
            }),
            _ => None,
        }
    }
}

/// `last-connect.json`, or nothing at all when there's no directory to put it
/// in (tests that build a `Service` with an empty path).
pub struct LastConnectFile {
    path: Option<PathBuf>,
}

impl LastConnectFile {
    pub fn new(app_data_dir: &Path) -> Self {
        let path = (!app_data_dir.as_os_str().is_empty()).then(|| app_data_dir.join("last-connect.json"));
        Self { path }
    }

    pub fn load(&self) -> Option<LastConnect> {
        let bytes = std::fs::read(self.path.as_ref()?).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Best-effort: a record that can't be written just means no pre-spawn next time.
    pub fn save(&self, record: &LastConnect) {
        let Some(path) = &self.path else { return };
        if self.load().as_ref() == Some(record) {
            return;
        }
        let tmp = path.with_extension("json.tmp");
        let result = serde_json::to_vec(record)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&tmp, bytes))
            .and_then(|()| restrict(&tmp))
            .and_then(|()| std::fs::rename(&tmp, path));
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("startup: couldn't save the last connection");
        }
    }

    pub fn clear(&self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-startup-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spawn(binary: Option<&str>, account: Option<&str>) -> ConnectConfig {
        ConnectConfig::Spawn { binary_path: binary.map(str::to_owned), account: account.map(str::to_owned) }
    }

    #[test]
    fn the_last_connection_round_trips_and_clears() {
        let dir = temp("round-trip");
        let file = LastConnectFile::new(&dir);
        assert_eq!(file.load(), None);
        let record = LastConnect { binary_path: Some("/opt/signal-cli".into()), linked: true };
        file.save(&record);
        assert_eq!(file.load(), Some(record));
        file.clear();
        assert_eq!(file.load(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_record_is_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("private");
        LastConnectFile::new(&dir).save(&LastConnect { binary_path: None, linked: false });
        let mode = std::fs::metadata(dir.join("last-connect.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_record_is_no_record() {
        let dir = temp("garbage");
        std::fs::write(dir.join("last-connect.json"), b"not json").unwrap();
        assert_eq!(LastConnectFile::new(&dir).load(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_directory_means_nothing_is_written() {
        let file = LastConnectFile::new(Path::new(""));
        file.save(&LastConnect { binary_path: None, linked: true });
        assert_eq!(file.load(), None);
    }

    #[test]
    fn only_spawn_mode_without_a_named_account_is_recorded() {
        assert_eq!(
            LastConnect::after_connect(None, &spawn(Some("/x"), None)),
            Some(LastConnect { binary_path: Some("/x".into()), linked: false })
        );
        assert_eq!(LastConnect::after_connect(None, &spawn(None, Some("+15550001"))), None);
        assert_eq!(LastConnect::after_connect(None, &ConnectConfig::External { url: "http://127.0.0.1:1".into() }), None);
    }

    #[test]
    fn a_new_connect_keeps_whether_an_account_was_linked() {
        let linked = LastConnect { binary_path: None, linked: true };
        let next = LastConnect::after_connect(Some(&linked), &spawn(Some("/y"), None)).unwrap();
        assert!(next.linked);
        assert_eq!(next.binary_path.as_deref(), Some("/y"));
    }

    #[test]
    fn only_a_linked_account_makes_a_record_eligible_for_prespawn() {
        let record = |linked| LastConnect { binary_path: Some("/x".into()), linked };
        assert_eq!(record(true).prespawn_config(), Some(spawn(Some("/x"), None)));
        assert_eq!(record(false).prespawn_config(), None);
    }
}
