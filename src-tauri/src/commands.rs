//! The Tauri commands the webview may call (each one listed in
//! capabilities/main.json; build.rs makes the rest uncallable).

use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{ConnectConfig, ResolvedBinary};
use crate::error::{Error, ErrorKind};
use crate::service::{ConnectInfo, ProbeResult, Service};
use crate::signal_cli_install::{self, InstallState, InstallStatus, PinnedAsset};

type Svc<'a> = State<'a, Arc<Service>>;
type Install<'a> = State<'a, Arc<InstallState>>;

/// Longest a single call may wait (finishLink waits for the phone to scan).
const MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[tauri::command]
pub async fn signal_cli_connect(service: Svc<'_>, config: ConnectConfig) -> Result<ConnectInfo, Error> {
    service.connect(config).await
}

#[tauri::command]
pub async fn signal_cli_request(
    service: Svc<'_>,
    method: String,
    params: Option<Map<String, Value>>,
    timeout_ms: Option<u64>,
) -> Result<Value, Error> {
    if method.is_empty() || method.len() > 64 || !method.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::new(ErrorKind::Config, "Invalid method name."));
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000)).min(MAX_TIMEOUT);
    service.request(&method, params, timeout).await
}

#[tauri::command]
pub async fn signal_cli_subscribe(service: Svc<'_>, account: Option<String>, resume_from: Option<String>) -> Result<String, Error> {
    service.subscribe(account, resume_from.unwrap_or_default()).await
}

#[tauri::command]
pub fn signal_cli_ack(service: Svc<'_>, cursor: String) {
    service.acknowledge(&cursor);
}

#[tauri::command]
pub async fn signal_cli_probe(service: Svc<'_>, config: ConnectConfig) -> Result<ProbeResult, Error> {
    service.probe(config).await
}

#[tauri::command]
pub fn signal_cli_locate(service: Svc<'_>, binary_path: Option<String>) -> Result<ResolvedBinary, Error> {
    service.locate(binary_path.as_deref())
}

/// The release this build would download (version, repo, approximate size),
/// for the first-run onboarding screen and Settings → Connection.
#[tauri::command]
pub fn signal_cli_pinned_release() -> Result<PinnedAsset, Error> {
    signal_cli_install::pinned()
}

/// Whether the pinned signal-cli is already downloaded.
#[tauri::command]
pub fn signal_cli_install_status(install: Install<'_>) -> InstallStatus {
    signal_cli_install::status(&install.app_data_dir)
}

/// Downloads and installs the pinned signal-cli release, reporting progress
/// via the `signal-cli-install-progress` event. Resolves once installed, or
/// fails with the reason (no network, a checksum mismatch, disk, or that it
/// was cancelled with `signal_cli_install_cancel`).
#[tauri::command]
pub async fn signal_cli_install(app: AppHandle, install: Install<'_>) -> Result<InstallStatus, Error> {
    let handle = app.clone();
    let on_progress: signal_cli_install::ProgressSink = Arc::new(move |progress| {
        let _ = handle.emit_to("main", crate::EVENT_INSTALL_PROGRESS, progress);
    });
    signal_cli_install::install_pinned(&install, on_progress).await
}

/// Cancels a signal-cli download/install in progress, if any.
#[tauri::command]
pub fn signal_cli_install_cancel(install: Install<'_>) {
    install.cancel();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// The signal-cli version Snowdrop manages here — downloaded on first
    /// launch, or (only in a build made with `tauri:build:bundled`) shipped
    /// inside the app. None when nothing's installed yet, or Settings →
    /// Connection points at a signal-cli the user supplied themselves.
    managed_signal_cli: Option<String>,
    /// Its upstream release page, when `managed_signal_cli` is set.
    signal_cli_release_url: Option<String>,
    /// Only set in a bundled build: its licence text (GPL-3.0), shipped as a
    /// Tauri resource. A downloaded signal-cli needs no notice here — it
    /// comes straight from AsamK/signal-cli's own release, never through us.
    signal_cli_license: Option<String>,
    /// Only set in a bundled build: a pointer to the exact source archive.
    signal_cli_source: Option<String>,
    data_dir: String,
    log_file: Option<String>,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, service: Svc<'_>, install: Install<'_>) -> DesktopInfo {
    let downloaded = signal_cli_install::status(&install.app_data_dir);
    let pinned = signal_cli_install::pinned().ok();
    let bundled_present = service.bundled().is_some();
    let managed_signal_cli =
        downloaded.version.or_else(|| bundled_present.then(|| pinned.as_ref().map(|p| p.version.clone())).flatten());
    let signal_cli_release_url =
        managed_signal_cli.is_some().then(|| pinned.as_ref().map(|p| format!("{}/releases/tag/v{}", p.repo, p.version))).flatten();

    // Only a bundled build ships these (fetch-signal-cli.mjs writes them as Tauri resources).
    let dir = app.path().resource_dir().ok().map(|d| d.join("licenses").join("signal-cli"));
    let read = |name: &str| dir.as_ref().and_then(|d| std::fs::read_to_string(d.join(name)).ok());
    let (signal_cli_license, signal_cli_source) =
        if bundled_present { (read("COPYING"), read("SOURCE.txt")) } else { (None, None) };

    let paths = app.state::<crate::AppPaths>();
    DesktopInfo {
        managed_signal_cli,
        signal_cli_release_url,
        signal_cli_license,
        signal_cli_source,
        data_dir: paths.data_dir.display().to_string(),
        log_file: paths.log_file.as_ref().map(|p| p.display().to_string()),
    }
}

/// Opens a link in the system browser (links never navigate the app window).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), Error> {
    if !is_external_url(&url) {
        return Err(Error::new(ErrorKind::Config, "Only web and email links can be opened."));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| Error::new(ErrorKind::Internal, e.to_string()))
}

pub fn is_external_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    url.len() <= 4096
        && !url.chars().any(char::is_control)
        && (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
}

#[cfg(test)]
mod tests {
    use super::is_external_url;

    #[test]
    fn opens_only_web_and_mail_links() {
        assert!(is_external_url("https://signal.org"));
        assert!(is_external_url("mailto:a@b.c"));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "smb://x", "https://a\nb"] {
            assert!(!is_external_url(bad), "{bad}");
        }
    }
}
