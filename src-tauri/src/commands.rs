//! The Tauri commands the webview may call (each one listed in
//! capabilities/main.json; build.rs makes the rest uncallable).

use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::config::{ConnectConfig, ResolvedBinary};
use crate::error::{Error, ErrorKind};
use crate::service::{ConnectInfo, ProbeResult, Service};

type Svc<'a> = State<'a, Arc<Service>>;

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
pub fn signal_cli_locate(service: Svc<'_>, use_bundled: bool, binary_path: Option<String>) -> Result<ResolvedBinary, Error> {
    service.locate(use_bundled, binary_path.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// The signal-cli shipped with this build (None: a build without the sidecar).
    bundled_signal_cli: Option<String>,
    /// Its licence (GPL-3.0) and where its exact source is, for the About page.
    signal_cli_license: Option<String>,
    signal_cli_source: Option<String>,
    data_dir: String,
    log_file: Option<String>,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, service: Svc<'_>) -> DesktopInfo {
    let dir = app.path().resource_dir().ok().map(|d| d.join("licenses").join("signal-cli"));
    let read = |name: &str| dir.as_ref().and_then(|d| std::fs::read_to_string(d.join(name)).ok());
    let source = read("SOURCE.txt");
    let version = source
        .as_deref()
        .and_then(|s| s.lines().next())
        .and_then(|l| l.strip_prefix("signal-cli "))
        .map(str::to_owned);
    let paths = app.state::<crate::AppPaths>();
    DesktopInfo {
        bundled_signal_cli: service.bundled().map(|_| version.unwrap_or_else(|| "bundled".into())),
        signal_cli_license: read("COPYING"),
        signal_cli_source: source,
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
