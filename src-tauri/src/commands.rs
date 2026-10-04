//! The Tauri commands the webview may call (each one listed in
//! capabilities/main.json; build.rs makes the rest uncallable).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{ConnectConfig, ResolvedBinary};
use crate::error::{Error, ErrorKind};
use crate::secrets::{self, KeyringStatus, KeyringStore};
use crate::service::{ConnectInfo, ProbeResult, Service};
use crate::signal_cli_install::{self, InstallState, InstallStatus, PinnedAsset};
use crate::storage::{SetupMode, StorageService, StorageStatus, UnlockMethod};

type Svc<'a> = State<'a, Arc<Service>>;
type Install<'a> = State<'a, Arc<InstallState>>;
type Storage<'a> = State<'a, Mutex<StorageService>>;

/// Longest a single call may wait (finishLink waits for the phone to scan).
const MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The only signal-cli JSON-RPC methods `signal_cli_request` will forward.
///
/// signal-cli also exposes account-destroying and config methods (register,
/// unregister, deleteLocalAccountData, updateConfiguration, setPin, removePin,
/// updateAccount, verify, addDevice, removeDevice, …) that no part of
/// Snowdrop's UI ever calls. Rather than trust the webview to only ask for
/// the right thing, this is a positive allow-list: every method here is one
/// actually called from src/core/backend/signal-cli or src/platform/tauri,
/// and everything else — known-dangerous or simply unrecognised — is
/// rejected before it reaches signal-cli. Keep this in sync with those call
/// sites; if the UI needs a new method, add it here deliberately.
const ALLOWED_METHODS: &[&str] = &[
    // Sending messages and conversation actions (SignalCliBackend.ts).
    "send",
    "sendTyping",
    "sendReceipt",
    "sendReaction",
    "sendAdminDelete",
    "sendPinMessage",
    "sendUnpinMessage",
    "remoteDelete",
    "updateContact",
    "updateGroup",
    // Directory (directory.ts).
    "listContacts",
    "listGroups",
    // Attachments (attachments.ts).
    "getAttachment",
    // Linking and accounts (SignalCliBackend.ts, probe.ts). Never
    // register/unregister/addDevice/removeDevice: those create or destroy
    // accounts rather than read or send through an existing one.
    "startLink",
    "finishLink",
    "listAccounts",
];

fn is_allowed_method(method: &str) -> bool {
    ALLOWED_METHODS.contains(&method)
}

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
    if !is_allowed_method(&method) {
        return Err(Error::new(ErrorKind::Config, format!("{method} is not a method Snowdrop's UI may call.")));
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

/// Whether the OS keyring is reachable and already holds a slot secret, for
/// the unlock screen and Settings → Privacy & security. Never returns the
/// secret itself — see `secrets::KeyringStatus`.
#[tauri::command]
pub fn storage_keyring_status() -> KeyringStatus {
    secrets::status(&KeyringStore::new())
}

/// `vaultDisabled` has two halves: `SNOWDROP_SIGNAL_CLI_DATA` (static,
/// `storage::StorageService` already knows it) and an external daemon
/// currently connected (live, only `Service` knows it — task 4b's wiring
/// lives there, not in `storage.rs`). Every storage command ORs the second
/// half in here before handing the status to the UI.
fn with_live_vault_disabled(mut status: StorageStatus, service: &Service) -> StorageStatus {
    status.vault_disabled = status.vault_disabled || service.is_external_active();
    status
}

#[tauri::command]
pub fn storage_status(storage: Storage<'_>, service: Svc<'_>) -> StorageStatus {
    let mut storage = storage.lock().expect("storage lock");
    with_live_vault_disabled(storage.status(), &service)
}

#[tauri::command]
pub fn storage_setup(
    storage: Storage<'_>,
    service: Svc<'_>,
    mode: SetupMode,
    passphrase: Option<String>,
) -> Result<StorageStatus, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let status = storage.setup_new(mode, passphrase.as_deref())?;
    Ok(with_live_vault_disabled(status, &service))
}

#[tauri::command]
pub fn storage_unlock(
    storage: Storage<'_>,
    service: Svc<'_>,
    method: UnlockMethod,
    secret: String,
    remember: bool,
) -> Result<StorageStatus, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let status = storage.unlock(method, &secret, remember)?;
    Ok(with_live_vault_disabled(status, &service))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecoveryResult {
    /// The plaintext recovery code, shown exactly once. Never log this.
    pub code: String,
    pub status: StorageStatus,
}

#[tauri::command]
pub fn storage_create_recovery(storage: Storage<'_>, service: Svc<'_>) -> Result<CreateRecoveryResult, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let (code, status) = storage.create_recovery()?;
    Ok(CreateRecoveryResult { code: code.to_string(), status: with_live_vault_disabled(status, &service) })
}

#[tauri::command]
pub fn storage_remove_recovery(storage: Storage<'_>, service: Svc<'_>) -> Result<StorageStatus, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let status = storage.remove_recovery()?;
    Ok(with_live_vault_disabled(status, &service))
}

#[tauri::command]
pub fn storage_set_passphrase(
    storage: Storage<'_>,
    service: Svc<'_>,
    passphrase: Option<String>,
) -> Result<StorageStatus, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let status = storage.set_passphrase(passphrase.as_deref())?;
    Ok(with_live_vault_disabled(status, &service))
}

#[tauri::command]
pub fn storage_enroll_keyring(storage: Storage<'_>, service: Svc<'_>) -> Result<StorageStatus, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let status = storage.enroll_keyring()?;
    Ok(with_live_vault_disabled(status, &service))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcacheKeyResult {
    /// Base64 of the 32-byte web cache subkey.
    pub key_base64: String,
}

/// Hands the webview the web cache key once, right after unlock
/// (docs/ENCRYPTION.md, "Web cache"). This looks like it defeats the vault,
/// but it doesn't: any code running inside the webview could already read
/// the *decrypted* cache it's about to use this key to decrypt, so handing
/// over the key itself exposes nothing a compromised webview doesn't already
/// have.
#[tauri::command]
pub fn storage_webcache_key(storage: Storage<'_>) -> Result<WebcacheKeyResult, Error> {
    let storage = storage.lock().expect("storage lock");
    let key = storage
        .webcache_key()
        .ok_or_else(|| Error::new(ErrorKind::Config, "Storage must be unlocked to read the web cache key."))?;
    Ok(WebcacheKeyResult { key_base64: STANDARD.encode(key) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseResult {
    pub status: StorageStatus,
    /// Best-effort: every item is attempted regardless, and anything that
    /// failed is named here rather than left for the user to discover later.
    pub failures: Vec<String>,
}

#[tauri::command]
pub fn storage_erase_all(storage: Storage<'_>, service: Svc<'_>, confirm: String) -> Result<EraseResult, Error> {
    let mut storage = storage.lock().expect("storage lock");
    let (status, failures) = storage.erase_all(&confirm)?;
    Ok(EraseResult { status: with_live_vault_disabled(status, &service), failures })
}

pub fn is_external_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    url.len() <= 4096
        && !url.chars().any(char::is_control)
        && (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_method, is_external_url, ALLOWED_METHODS};

    #[test]
    fn opens_only_web_and_mail_links() {
        assert!(is_external_url("https://signal.org"));
        assert!(is_external_url("mailto:a@b.c"));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "smb://x", "https://a\nb"] {
            assert!(!is_external_url(bad), "{bad}");
        }
    }

    #[test]
    fn allows_every_method_the_ui_actually_calls() {
        for method in ALLOWED_METHODS {
            assert!(is_allowed_method(method), "{method} should be allowed");
        }
    }

    /// Account-destroying and config methods must never be reachable from the
    /// webview, even though signal-cli itself implements them.
    #[test]
    fn rejects_account_destroying_and_config_methods() {
        for method in [
            "unregister",
            "deleteLocalAccountData",
            "updateConfiguration",
            "removePin",
            "setPin",
            "register",
            "verify",
            "updateAccount",
            "addDevice",
            "removeDevice",
        ] {
            assert!(!is_allowed_method(method), "{method} should be rejected");
        }
    }

    #[test]
    fn rejects_unknown_or_malformed_methods() {
        for method in [
            "",
            "Send",
            "send ",
            "sendMessage",
            "subscribeReceive",
            "unsubscribeReceive",
            "version",
            "eval(1)",
        ] {
            assert!(!is_allowed_method(method), "{method} should be rejected");
        }
    }
}
