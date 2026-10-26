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
use crate::perf::CommandTimer;
use crate::secrets::{self, KeyringStatus, KeyringStore};
use crate::service::{ConnectInfo, ProbeResult, Service};
use crate::signal_cli_install::{self, InstallState, InstallStatus, PinnedAsset};
use crate::storage::{SetupMode, StorageService, StorageStatus, UnlockMethod};
use crate::tray;
use crate::CloseGate;

type Svc<'a> = State<'a, Arc<Service>>;
type Install<'a> = State<'a, Arc<InstallState>>;
type CloseLatch<'a> = State<'a, Arc<CloseGate>>;

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
    // Read receipts; `syncOnly` (patch 0023) is a plain boolean, so it passes rpc_guard.rs as is.
    "sendReceipt",
    "sendReaction",
    "sendAdminDelete",
    "sendPinMessage",
    "sendUnpinMessage",
    // Polls (SignalCliBackend.ts: send with a poll, votePoll, terminatePoll):
    // create one in a conversation, change our answer on one, end one of ours.
    // Plain strings, numbers and booleans only (a question, its options, option
    // indexes, a poll's timestamp), so they pass rpc_guard.rs as is.
    "sendPollCreate",
    "sendPollVote",
    "sendPollTerminate",
    "remoteDelete",
    "updateContact",
    "updateGroup",
    // Message requests (SignalCliBackend.ts: respondToMessageRequest,
    // setBlocked): accept or delete a request, block/unblock a contact or
    // group, and leave a group whose request was deleted. All take only a
    // recipient or group id (no files), so they pass rpc_guard.rs as is.
    "sendMessageRequestResponse",
    "block",
    "unblock",
    "quitGroup",
    // Directory (directory.ts).
    "listContacts",
    "listGroups",
    // The new-message dialog's "Find by phone number" / "Find by username"
    // (SignalCliBackend.ts: lookupRecipient): asks the server whether a number
    // or username belongs to a Signal user. Read-only, sends nothing to them,
    // and takes only strings, so it passes rpc_guard.rs as is.
    "getUserStatus",
    // Asks the primary device to resend contacts/groups/the block list
    // (SignalCliBackend.ts: syncContactsAndGroups, Settings → Connection).
    "sendSyncRequest",
    // Attachments (attachments.ts).
    "getAttachment",
    // Stickers (attachments.ts: getSticker; SignalCliBackend.ts: a history
    // sticker's pack is registered locally, never installed or synced).
    "getSticker",
    "registerHistoryStickerPack",
    // The sticker picker (SignalCliBackend.ts: listStickerPacks): a read-only
    // listing of the packs. Never addStickerPack/uploadStickerPack/
    // removeStickerPack: those take a pack key or uninstall.
    "listStickerPacks",
    // The pack dialog's explicit, user-clicked "Install" for a pack already
    // seen in a received sticker (SignalCliBackend.ts: installStickerPack).
    // Takes only a pack id; signal-cli looks the key up itself.
    "installKnownStickerPack",
    // Asks the primary device to re-upload an expired history attachment
    // (SignalCliBackend.ts: requestAttachmentBackfill).
    "requestAttachmentBackfill",
    "getHistoryDirectory",
    "getHistoryChat",
    "readHistory",
    "getHistoryReadState",
    // Linking and accounts (SignalCliBackend.ts, probe.ts). Never
    // register/unregister/addDevice/removeDevice: those create or destroy
    // accounts rather than read or send through an existing one.
    "startLink",
    "finishLink",
    "listAccounts",
    // The privacy settings the phone syncs (SignalCliBackend.ts: readPhonePrivacy /
    // updatePhonePrivacy). `getConfiguration` is a read; `updateConfiguration`
    // is restricted by rpc_guard.rs to the privacy booleans and nothing else.
    "getConfiguration",
    "updateConfiguration",
    // Capability detection (SignalCliBackend.ts: supportsCustomEmojiDelivery)
    // — reads back the running signal-cli's own version string so the UI can
    // tell whether it's a patched build that can deliver custom emoji images.
    // Takes no account and changes nothing.
    "version",
    // Settings → Profile (SignalCliBackend.ts: updateProfile): the user's own
    // name, about text and photo. rpc_guard.rs lets through only those
    // fields (never `mobileCoinAddress`) and requires the photo to be a data:
    // URI. It uploads the profile and tells the phone to refetch it.
    "updateProfile",
];

#[cfg(test)]
fn is_allowed_method(method: &str) -> bool {
    allowed_method(method).is_some()
}

/// The allow-list's own `'static` copy of `method`, if it's allowed.
fn allowed_method(method: &str) -> Option<&'static str> {
    ALLOWED_METHODS.iter().copied().find(|m| *m == method)
}

#[tauri::command]
pub async fn signal_cli_connect(service: Svc<'_>, config: ConnectConfig) -> Result<ConnectInfo, Error> {
    let _t = CommandTimer::start("signal_cli_connect");
    service.connect(config).await
}

/// Forces a fresh signal-cli process even if the current one is still
/// answering (see `Service::restart`): used when a previously-linked
/// account went missing from `listAccounts` without signal-cli crashing.
#[tauri::command]
pub async fn signal_cli_restart(service: Svc<'_>, config: ConnectConfig) -> Result<ConnectInfo, Error> {
    let _t = CommandTimer::start("signal_cli_restart");
    service.restart(config).await
}

#[tauri::command]
pub async fn signal_cli_request(
    service: Svc<'_>,
    method: String,
    params: Option<Map<String, Value>>,
    timeout_ms: Option<u64>,
) -> Result<Value, Error> {
    let Some(allowed) = allowed_method(&method) else {
        return Err(Error::new(ErrorKind::Config, format!("{method} is not a method Snowdrop's UI may call.")));
    };
    // signal-cli reads any non-`data:` file reference as a host path: refuse those.
    crate::rpc_guard::validate_request(&method, params.as_ref())?;
    let _t = CommandTimer::start_with_detail("signal_cli_request", allowed);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000)).min(MAX_TIMEOUT);
    service.request(&method, params, timeout).await
}

#[tauri::command]
pub async fn signal_cli_subscribe(service: Svc<'_>, account: Option<String>, resume_from: Option<String>) -> Result<String, Error> {
    let _t = CommandTimer::start("signal_cli_subscribe");
    service.subscribe(account, resume_from.unwrap_or_default()).await
}

// Kept sync and trivial: an in-memory cursor bump, no lock contention or IO.
#[tauri::command]
pub fn signal_cli_ack(service: Svc<'_>, cursor: String) {
    let _t = CommandTimer::start("signal_cli_ack");
    service.acknowledge(&cursor);
}

#[tauri::command]
pub async fn signal_cli_probe(service: Svc<'_>, config: ConnectConfig) -> Result<ProbeResult, Error> {
    let _t = CommandTimer::start("signal_cli_probe");
    service.probe(config).await
}

/// Resolves the signal-cli binary to run: walks `PATH` and stats candidate
/// files, which can block on a slow or network filesystem — run off the
/// main (GTK) thread.
#[tauri::command]
pub async fn signal_cli_locate(service: Svc<'_>, binary_path: Option<String>) -> Result<ResolvedBinary, Error> {
    let _t = CommandTimer::start("signal_cli_locate");
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.locate(binary_path.as_deref()))
        .await
        .expect("signal_cli_locate: blocking task panicked")
}

/// The release this build would download (version, repo, approximate size),
/// for the first-run onboarding screen and Settings → Connection. Kept
/// sync: it only parses an already-cached, compiled-in JSON string.
#[tauri::command]
pub fn signal_cli_pinned_release() -> Result<PinnedAsset, Error> {
    let _t = CommandTimer::start("signal_cli_pinned_release");
    signal_cli_install::pinned()
}

/// Whether the pinned signal-cli is already downloaded: stats the install
/// path, which can block — run off the main thread.
///
/// Takes `app: AppHandle` rather than `Install<'_>`: an async command whose
/// inputs borrow from the invoke (a `State`) must return a `Result`
/// (a Tauri requirement), and this one has nothing to fail with — looking
/// the state up again from an owned, `'static` handle sidesteps that
/// instead of inventing an error case that can never happen.
#[tauri::command]
pub async fn signal_cli_install_status(app: AppHandle) -> InstallStatus {
    let _t = CommandTimer::start("signal_cli_install_status");
    tauri::async_runtime::spawn_blocking(move || {
        let install = app.state::<Arc<InstallState>>();
        signal_cli_install::status(&install.app_data_dir)
    })
    .await
    .expect("signal_cli_install_status: blocking task panicked")
}

/// Downloads and installs the pinned signal-cli release, reporting progress
/// via the `signal-cli-install-progress` event. Resolves once installed, or
/// fails with the reason (no network, a checksum mismatch, disk, or that it
/// was cancelled with `signal_cli_install_cancel`).
#[tauri::command]
pub async fn signal_cli_install(app: AppHandle, install: Install<'_>) -> Result<InstallStatus, Error> {
    let _t = CommandTimer::start("signal_cli_install");
    let handle = app.clone();
    let on_progress: signal_cli_install::ProgressSink = Arc::new(move |progress| {
        let _ = handle.emit_to("main", crate::EVENT_INSTALL_PROGRESS, progress);
    });
    signal_cli_install::install_pinned(&install, on_progress).await
}

/// Cancels a signal-cli download/install in progress, if any. Kept sync: it
/// only flips a shared cancel flag.
#[tauri::command]
pub fn signal_cli_install_cancel(install: Install<'_>) {
    let _t = CommandTimer::start("signal_cli_install_cancel");
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
    /// Whether a system tray icon exists at all on this host (`tray.rs`) —
    /// false on Linux with no AppIndicator/StatusNotifierItem host, or if
    /// building the tray icon failed for some other reason. Settings →
    /// Behaviour hides "Keep running in the tray" when this is false.
    tray_available: bool,
}

/// Reads the install status and (in a bundled build) a couple of licence
/// files off disk — run off the main thread. Takes `app: AppHandle` only
/// (see `signal_cli_install_status`'s doc comment for why), looking
/// `Service`/`InstallState` up again from it inside the blocking closure.
#[tauri::command]
pub async fn desktop_info(app: AppHandle) -> DesktopInfo {
    let _t = CommandTimer::start("desktop_info");
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<Arc<Service>>();
        let install = app.state::<Arc<InstallState>>();
        let downloaded = signal_cli_install::status(&install.app_data_dir);
        let pinned = signal_cli_install::pinned().ok();
        let bundled_present = service.bundled().is_some();
        let managed_signal_cli = downloaded
            .version
            .or_else(|| bundled_present.then(|| pinned.as_ref().map(|p| p.version.clone())).flatten());
        let signal_cli_release_url = managed_signal_cli
            .is_some()
            .then(|| pinned.as_ref().map(|p| format!("{}/releases/tag/v{}", p.repo, p.version)))
            .flatten();

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
            tray_available: tray::available(&app),
        }
    })
    .await
    .expect("desktop_info: blocking task panicked")
}

/// Opens a link in the system browser (links never navigate the app window).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), Error> {
    let _t = CommandTimer::start("open_external");
    if !is_external_url(&url) {
        return Err(Error::new(ErrorKind::Config, "Only web and email links can be opened."));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| Error::new(ErrorKind::Internal, e.to_string()))
}

/// Whether the OS keyring is reachable and already holds a slot secret, for
/// the unlock screen and Settings → Privacy & security. Never returns the
/// secret itself — see `secrets::KeyringStatus`. Talks to the Secret
/// Service over D-Bus, which can block for a while (a locked keyring, or
/// none running at all) — run off the main thread.
#[tauri::command]
pub async fn storage_keyring_status() -> KeyringStatus {
    let _t = CommandTimer::start("storage_keyring_status");
    tauri::async_runtime::spawn_blocking(|| secrets::status(&KeyringStore::new()))
        .await
        .expect("storage_keyring_status: blocking task panicked")
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

/// Storage just became (or is) open: start signal-cli now if it was linked
/// last time (`Service::prespawn`; a no-op otherwise, and after the first
/// attempt). Runs on the async runtime so the storage command doesn't wait
/// for it, and never with storage's lock held.
fn kick_prespawn(app: &AppHandle, status: &StorageStatus) {
    if status.state != "unlocked" {
        return;
    }
    let service = app.state::<Arc<Service>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        service.prespawn().await;
    });
}

/// `storage_status`/`storage_setup`/`storage_unlock`/.../`storage_sign_out`
/// below all take `app: AppHandle` rather than a `State<Mutex<...>>`
/// parameter: the actual work (Argon2 hashing, keyring/D-Bus calls, file
/// IO) runs inside `tauri::async_runtime::spawn_blocking`, whose closure
/// must be `Send + 'static` — `AppHandle` is (and is cheap to clone), a
/// borrowed `State` isn't. Each closure looks the managed state up again
/// from the handle and locks it only for its own, brief critical section;
/// no lock is ever held across an `.await`.
#[tauri::command]
pub async fn storage_status(app: AppHandle) -> StorageStatus {
    let _t = CommandTimer::start("storage_status");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.status();
        drop(storage);
        kick_prespawn(&app, &status);
        with_live_vault_disabled(status, &service)
    })
    .await
    .expect("storage_status: blocking task panicked")
}

#[tauri::command]
pub async fn storage_setup(
    app: AppHandle,
    mode: SetupMode,
    passphrase: Option<String>,
) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_setup");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.setup_new(mode, passphrase.as_deref())?;
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_setup: blocking task panicked")
}

#[tauri::command]
pub async fn storage_unlock(
    app: AppHandle,
    method: UnlockMethod,
    secret: String,
    remember: bool,
) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_unlock");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.unlock(method, &secret, remember)?;
        drop(storage);
        kick_prespawn(&app, &status);
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_unlock: blocking task panicked")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecoveryResult {
    /// The plaintext recovery code, shown exactly once. Never log this.
    pub code: String,
    pub status: StorageStatus,
}

#[tauri::command]
pub async fn storage_create_recovery(app: AppHandle) -> Result<CreateRecoveryResult, Error> {
    let _t = CommandTimer::start("storage_create_recovery");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let (code, status) = storage.create_recovery()?;
        Ok(CreateRecoveryResult { code: code.to_string(), status: with_live_vault_disabled(status, &service) })
    })
    .await
    .expect("storage_create_recovery: blocking task panicked")
}

#[tauri::command]
pub async fn storage_remove_recovery(app: AppHandle) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_remove_recovery");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.remove_recovery()?;
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_remove_recovery: blocking task panicked")
}

#[tauri::command]
pub async fn storage_set_passphrase(app: AppHandle, passphrase: Option<String>) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_set_passphrase");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.set_passphrase(passphrase.as_deref())?;
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_set_passphrase: blocking task panicked")
}

#[tauri::command]
pub async fn storage_enroll_keyring(app: AppHandle) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_enroll_keyring");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let mut storage = storage.lock().expect("storage lock");
        let status = storage.enroll_keyring()?;
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_enroll_keyring: blocking task panicked")
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
pub async fn storage_webcache_key(app: AppHandle) -> Result<WebcacheKeyResult, Error> {
    let _t = CommandTimer::start("storage_webcache_key");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let storage = storage.lock().expect("storage lock");
        let key = storage
            .webcache_key()
            .ok_or_else(|| Error::new(ErrorKind::Config, "Storage must be unlocked to read the web cache key."))?;
        Ok(WebcacheKeyResult { key_base64: STANDARD.encode(key) })
    })
    .await
    .expect("storage_webcache_key: blocking task panicked")
}

/// Encrypts a history export under a passphrase the user typed
/// (`export_crypto`; docs/ENCRYPTION.md, "Encrypted history export"). The
/// Argon2id derivation takes a noticeable fraction of a second, so it runs
/// off the async runtime. Returns the file's bytes as base64.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEncryptResult {
    pub file_base64: String,
}

#[tauri::command]
pub async fn storage_export_encrypt(passphrase: String, plaintext: String) -> Result<ExportEncryptResult, Error> {
    let _t = CommandTimer::start("storage_export_encrypt");
    let passphrase = zeroize::Zeroizing::new(passphrase);
    let plaintext = zeroize::Zeroizing::new(plaintext);
    tauri::async_runtime::spawn_blocking(move || {
        let sealed = crate::export_crypto::seal_export(&passphrase, plaintext.as_bytes())?;
        Ok(ExportEncryptResult { file_base64: STANDARD.encode(sealed) })
    })
    .await
    .expect("storage_export_encrypt: blocking task panicked")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseResult {
    pub status: StorageStatus,
    /// Best-effort: every item is attempted regardless, and anything that
    /// failed is named here rather than left for the user to discover later.
    pub failures: Vec<String>,
}

/// Split into three locking phases (`storage::StorageService::begin_erase`/
/// `finish_erase`) rather than one `erase_all` call held under `storage`'s
/// lock throughout: the erase hooks reach back into `Service` to stop
/// signal-cli, which needs `Service`'s own `active` lock — the exact lock
/// `Service::connect` holds while calling back into storage. Holding
/// `storage`'s lock across the hooks would deadlock against a concurrent
/// `connect` (docs/ENCRYPTION.md, "Erase"; see `storage.rs`'s
/// `begin_erase` for the full account).
#[tauri::command]
pub async fn storage_erase_all(app: AppHandle, confirm: String) -> Result<EraseResult, Error> {
    let _t = CommandTimer::start("storage_erase_all");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let prep = storage.lock().expect("storage lock").begin_erase(&confirm)?;
        for hook in &prep.hooks {
            hook();
        }
        let (status, failures) = storage.lock().expect("storage lock").finish_erase(prep)?;
        Ok(EraseResult { status: with_live_vault_disabled(status, &service), failures })
    })
    .await
    .expect("storage_erase_all: blocking task panicked")
}

/// Signs out of Signal on this computer (docs/ENCRYPTION.md, "Sign out"):
/// removes this computer's signal-cli vault, but keeps `keys.json` and the
/// keyring entry so storage stays set up. Like `storage_erase_all`, the
/// webview must restart the app (`app_restart`) before storage is usable
/// again.
///
/// Split into locking phases the same way, and for the same reason, as
/// `storage_erase_all` above: see `storage::StorageService::begin_sign_out`.
#[tauri::command]
pub async fn storage_sign_out(app: AppHandle) -> Result<StorageStatus, Error> {
    let _t = CommandTimer::start("storage_sign_out");
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Mutex<StorageService>>();
        let service = app.state::<Arc<Service>>();
        let hooks = storage.lock().expect("storage lock").begin_sign_out()?;
        for hook in &hooks {
            hook();
        }
        let status = storage.lock().expect("storage lock").finish_sign_out()?;
        Ok(with_live_vault_disabled(status, &service))
    })
    .await
    .expect("storage_sign_out: blocking task panicked")
}

/// Restarts the whole Snowdrop process. Needed after `storage_erase_all`:
/// the vault bridge and the single-instance lock (`snowdrop.lock`) are both
/// one-shot per process, so the only way back to a clean `needsSetup` boot
/// is a fresh process, not just a webview reload
/// (docs/ENCRYPTION.md, "Erase").
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}

/// Answers `snowdrop://flush-before-close` (docs/ENCRYPTION.md, "signal-cli
/// vault": the close handshake that keeps the last write from being lost):
/// the frontend has finished (or given up on) its own last-write-before-close
/// work, so it's safe to actually exit now. A no-op if the close already
/// went through via `lib.rs`'s fallback timer.
#[tauri::command]
pub fn app_close_ready(app: AppHandle, gate: CloseLatch<'_>) {
    let _t = CommandTimer::start("app_close_ready");
    if gate.fire() {
        app.exit(0);
    }
}

/// Mirrors the frontend's computed total unread (`totalUnread` in
/// src/core/stores/views.ts — muted chats excluded, the same total the TUI
/// shell's own status line shows) to the tray badge/tooltip/title, the
/// taskbar/dock badge and the window title (`tray::set_unread`). Called
/// from a debounced, change-only subscriber on the frontend
/// (`src/app/unreadSync.ts`), so this itself just applies whatever it's
/// given.
#[tauri::command]
pub fn app_set_unread(app: AppHandle, count: u32, _mentions: u32) {
    let _t = CommandTimer::start("app_set_unread");
    // `mentions` isn't used by the badge today — `count` already is the
    // same total the status line uses — but it's accepted
    // here so a future affordance (e.g. a mention-only indicator while
    // muted) never needs a new command, just a new use of this parameter.
    tray::set_unread(&app, count);
}

/// Mirrors Settings → Behaviour's "Keep running in the tray"
/// (`behaviour.closeToTray`, src/core/stores/settings.ts) so the main
/// window's `CloseRequested` (`lib.rs`) can decide hide-vs-quit
/// (`tray::close_decision`) — Rust has no access to the frontend's own
/// settings store to read it directly.
#[tauri::command]
pub fn app_set_close_to_tray(app: AppHandle, enabled: bool) {
    let _t = CommandTimer::start("app_set_close_to_tray");
    app.state::<Arc<tray::CloseToTray>>().set(enabled);
}

pub fn is_external_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    url.len() <= 4096
        && !url.chars().any(char::is_control)
        && (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_method, is_external_url, valid_log_scope};

    #[test]
    fn opens_only_web_and_mail_links() {
        assert!(is_external_url("https://signal.org"));
        assert!(is_external_url("mailto:a@b.c"));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "smb://x", "https://a\nb"] {
            assert!(!is_external_url(bad), "{bad}");
        }
    }

    /// Every `.call('method', …)` in the signal-cli backend's non-test sources
    /// must be on the allow-list, or that feature fails in the desktop app
    /// only (the browser mock and the unit tests never go through here).
    #[test]
    fn allows_every_method_the_ui_actually_calls() {
        fn visit(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).expect("readable src dir") {
                let path = entry.expect("dir entry").path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
                if path.is_dir() {
                    visit(&path, out);
                } else if name.ends_with(".ts") && !name.contains(".test.") {
                    let text = std::fs::read_to_string(&path).expect("readable source");
                    // `rpc.call('method', …)` and the backend's own `command('method', …)` helper.
                    for opener in [".call(", ".command("] {
                        for (i, _) in text.match_indices(opener) {
                            let rest = text[i + opener.len()..].trim_start();
                            if let Some(quoted) = rest.strip_prefix('\'') {
                                let method: String = quoted.chars().take_while(char::is_ascii_alphanumeric).collect();
                                if !method.is_empty() && quoted[method.len()..].starts_with('\'') {
                                    out.push((method, path.display().to_string()));
                                }
                            }
                        }
                    }
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/core/backend/signal-cli");
        let mut calls = Vec::new();
        visit(&src, &mut calls);
        assert!(calls.iter().any(|(m, _)| m == "getAttachment"), "the scan found no calls; did the layout change?");
        for (method, file) in calls {
            assert!(is_allowed_method(&method), "{file} calls {method}, which ALLOWED_METHODS rejects");
        }
    }

    /// The three poll methods are allowed, exactly: near-misses and the other
    /// poll-adjacent names signal-cli doesn't offer to the UI stay rejected.
    #[test]
    fn allows_exactly_the_poll_methods() {
        for method in ["sendPollCreate", "sendPollVote", "sendPollTerminate"] {
            assert!(is_allowed_method(method), "{method}");
        }
        for method in ["sendPoll", "sendPollCreate ", "sendpollvote", "SendPollTerminate", "pollVote", "sendPollVotes", ""] {
            assert!(!is_allowed_method(method), "{method:?}");
        }
    }

    /// Every `invoke('command', …)` in the desktop platform layer must be in
    /// lib.rs's `generate_handler!`: an unregistered command is rejected at
    /// runtime, and the fire-and-forget callers (tray badge, close-to-tray)
    /// swallow that, so the feature silently does nothing.
    #[test]
    fn registers_every_command_the_ui_invokes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lib = std::fs::read_to_string(root.join("src/lib.rs")).expect("readable lib.rs");
        let handler = &lib[lib.find("generate_handler![").expect("lib.rs registers commands")..];
        let handler = &handler[..handler.find(']').expect("generate_handler! is closed")];
        let registered: Vec<&str> = handler
            .split(|c: char| c == ',' || c.is_whitespace() || c == '[')
            .filter_map(|t| t.rsplit("::").next())
            .filter(|t| !t.is_empty())
            .collect();
        let dir = root.join("../src/platform/tauri");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).expect("readable platform dir") {
            let path = entry.expect("dir entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
            if !name.ends_with(".ts") || name.contains(".test.") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable source");
            for (i, _) in text.match_indices("invoke") {
                let rest = &text[i + "invoke".len()..];
                let rest = rest.strip_prefix("<").map_or(rest, |r| &r[r.find('>').map_or(0, |j| j + 1)..]);
                let Some(quoted) = rest.strip_prefix("('") else { continue };
                let command: String = quoted.chars().take_while(|c| c.is_ascii_lowercase() || *c == '_').collect();
                if command.is_empty() || !quoted[command.len()..].starts_with('\'') {
                    continue;
                }
                seen += 1;
                assert!(registered.contains(&command.as_str()), "{name} invokes {command}, which lib.rs never registers");
            }
        }
        assert!(seen > 20, "the scan found only {seen} invokes; did the layout change?");
    }

    /// Settings → Connection → "Sync contacts and groups" (SignalCliBackend.ts:
    /// syncContactsAndGroups) goes through this exact method.
    #[test]
    fn allows_the_contacts_and_groups_sync_request() {
        assert!(is_allowed_method("sendSyncRequest"));
    }

    /// The new-message dialog's recipient lookup (SignalCliBackend.ts:
    /// lookupRecipient) goes through this exact method; it passes the guard
    /// with plain string lists, and a file path smuggled into it still fails.
    #[test]
    fn allows_the_recipient_lookup() {
        assert!(is_allowed_method("getUserStatus"));
        let ok = serde_json::json!({ "recipient": ["+15550001111"], "username": ["alice.42"] });
        assert!(crate::rpc_guard::validate_request("getUserStatus", ok.as_object()).is_ok());
        let bad = serde_json::json!({ "recipient": ["+15550001111"], "attachment": "/etc/passwd" });
        assert!(crate::rpc_guard::validate_request("getUserStatus", bad.as_object()).is_err());
    }

    /// Custom-emoji capability detection (SignalCliBackend.ts:
    /// supportsCustomEmojiDelivery) reads the daemon's version string back.
    #[test]
    fn allows_the_version_capability_probe() {
        assert!(is_allowed_method("version"));
    }

    /// Message requests (SignalCliBackend.ts: respondToMessageRequest and
    /// setBlocked): answering one, blocking and leaving a group are reachable.
    #[test]
    fn allows_answering_and_blocking_message_requests() {
        for method in ["sendMessageRequestResponse", "block", "unblock", "quitGroup"] {
            assert!(is_allowed_method(method), "{method} should be allowed");
        }
    }

    /// The sticker picker lists packs and sends through `send`, and the pack
    /// dialog installs a pack seen in a received sticker by id alone
    /// (`installKnownStickerPack`); the key-taking and uninstalling methods
    /// stay unreachable.
    #[test]
    fn allows_listing_and_installing_a_known_pack_but_not_key_taking_methods() {
        assert!(is_allowed_method("listStickerPacks"));
        assert!(is_allowed_method("installKnownStickerPack"));
        assert!(is_allowed_method("send"));
        for method in ["addStickerPack", "uploadStickerPack", "removeStickerPack"] {
            assert!(!is_allowed_method(method), "{method} should be rejected");
        }
    }

    /// `updateConfiguration` is reachable, but only under rpc_guard's strict
    /// key allow-list (see `rpc_guard::validate_request`).
    #[test]
    fn allows_reading_and_updating_the_privacy_configuration() {
        assert!(is_allowed_method("getConfiguration"));
        assert!(is_allowed_method("updateConfiguration"));
    }

    /// `updateProfile` is reachable for the profile editor, but only under
    /// rpc_guard's strict key allow-list (see `rpc_guard::validate_request`).
    #[test]
    fn allows_updating_the_own_profile() {
        assert!(is_allowed_method("updateProfile"));
        assert!(!is_allowed_method("updateprofile"));
    }

    /// Account-destroying and config methods must never be reachable from the
    /// webview, even though signal-cli itself implements them.
    #[test]
    fn rejects_account_destroying_and_config_methods() {
        for method in [
            "unregister",
            "deleteLocalAccountData",
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
            "updateprofile",
            "eval(1)",
        ] {
            assert!(!is_allowed_method(method), "{method} should be rejected");
        }
    }

    #[test]
    fn accepts_well_formed_log_scopes() {
        for scope in ["ui", "settings", "render-tree", "a:b:c", "0", &"a".repeat(32)] {
            assert!(valid_log_scope(scope), "{scope} should be accepted");
        }
    }

    #[test]
    fn rejects_malformed_log_scopes() {
        for scope in ["", &"a".repeat(33), "Settings", "has space", "has_underscore", "emoji😀"] {
            assert!(!valid_log_scope(scope), "{scope} should be rejected");
        }
    }
}

/// `[a-z0-9:-]{1,32}`: short enough, and plain enough, that a `ui:<scope>`
/// log target can never be mistaken for anything else routed through
/// [`crate::applog`] (`rust:<module>`, `signal-cli`).
fn valid_log_scope(scope: &str) -> bool {
    (1..=32).contains(&scope.len()) && scope.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-')
}

fn parse_frontend_level(level: &str) -> log::Level {
    match level {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        // "info", and anything unrecognised: still worth keeping, at Info.
        _ => log::Level::Info,
    }
}

/// A frontend log line (uncaught render error, unhandled rejection, or the
/// app's own diagnostic logging — `src/platform/tauri/frontendLog.ts`),
/// routed through the app-wide logger at target `ui:<scope>`: redacted and
/// written to `snowdrop.log` exactly like every other source. An invalid
/// `scope` falls back to the generic `ui` target rather than dropping the
/// line, since the frontend is the one source this command can't fully
/// trust to format its own target correctly.
// Kept sync: a format! and one buffered log write, not worth a thread hop.
#[tauri::command]
pub fn frontend_log(level: String, scope: String, message: String) {
    let _t = CommandTimer::start("frontend_log");
    let scope = if valid_log_scope(&scope) { scope } else { "ui".to_string() };
    let target = format!("ui:{scope}");
    log::log!(target: target.as_str(), parse_frontend_level(&level), "{message}");
}

/// Raises the running app's log floor to Debug, or back down, from a
/// developer toggle in Settings (`crate::applog::set_verbose`). Kept sync:
/// an atomic flag flip.
#[tauri::command]
pub fn log_set_verbose(verbose: bool) {
    let _t = CommandTimer::start("log_set_verbose");
    crate::applog::set_verbose(verbose);
}

/// The tail of `snowdrop.log` (plus `.1` if needed), already redacted
/// because it was written redacted. `max_bytes` is capped server-side
/// (`applog::recent`) regardless of what's asked. Reads the log file(s)
/// from disk — run off the main thread.
#[tauri::command]
pub async fn log_recent(max_bytes: u32) -> String {
    let _t = CommandTimer::start("log_recent");
    tauri::async_runtime::spawn_blocking(move || crate::applog::recent(max_bytes as usize))
        .await
        .expect("log_recent: blocking task panicked")
}

/// Opens the log directory in the system file manager. The path is always
/// the fixed app log dir Tauri resolves — never one the frontend supplies.
/// Spawning the file manager can block for a bit — run off the main thread.
#[tauri::command]
pub async fn log_open_folder(app: AppHandle) -> Result<(), Error> {
    let _t = CommandTimer::start("log_open_folder");
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_log_dir().map_err(|e| Error::new(ErrorKind::Internal, e.to_string()))?;
        tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| Error::new(ErrorKind::Internal, e.to_string()))
    })
    .await
    .expect("log_open_folder: blocking task panicked")
}

/// Returns false where the frontend should use the platform plugin instead.
#[tauri::command]
pub async fn notification_show(
    state: tauri::State<'_, std::sync::Arc<crate::notifications::Notifications>>,
    tag: String,
    title: String,
    body: String,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || state.show(tag, title, body))
            .await
            .map_err(|e| e.to_string())??;
        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, tag, title, body);
        Ok(false)
    }
}

#[tauri::command]
pub async fn notification_close(
    state: tauri::State<'_, std::sync::Arc<crate::notifications::Notifications>>,
    tag: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || state.close(tag))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, tag);
        Ok(())
    }
}


#[tauri::command]
pub async fn clipboard_read_files(
    app: tauri::AppHandle,
    gate: State<'_, Arc<crate::paste_gate::PasteGate>>,
) -> Result<Vec<crate::clipboard::ClipboardFile>, String> {
    // Only right after a native paste gesture (Ctrl+V, Shift+Insert, or the
    // context menu): see paste_gate.rs. Consumed by this read.
    #[cfg(target_os = "linux")]
    {
        if !gate.is_open(std::time::Instant::now()) {
            return Err("Paste with Ctrl+V in the message box to attach files.".into());
        }
        gate.close();
    }
    #[cfg(not(target_os = "linux"))]
    let _ = &gate;
    crate::clipboard::read(app).await
}

/// Settings → Behaviour → "Link previews" (desktop only; see
/// src/link_preview.rs for the fetch itself and its privacy posture).
#[tauri::command]
pub async fn link_preview_fetch(
    url: String,
) -> Result<Option<crate::link_preview::FetchedPreview>, String> {
    crate::link_preview::link_preview_fetch(url).await
}
