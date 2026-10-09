//! Snowdrop's desktop shell (Tauri v2): one window running the web UI, and
//! the signal-cli connection the UI drives through a handful of commands.
//! See docs/DESKTOP.md.

pub mod aead;
#[cfg(target_os = "linux")]
mod appimage;
pub mod applog;
pub mod clipboard;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod external;
pub mod jsonrpc;
pub mod keyslots;
pub mod logfile;
pub mod notifications;
pub mod perf;
pub mod process;
pub mod redact;
pub mod secrets;
pub mod service;
pub mod signal_cli_install;
pub mod storage;
pub mod vault;
pub mod vault_bridge;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use crate::events::HeldEvent;
use crate::service::{EventSink, Paths, Service, StreamState};
use crate::signal_cli_install::InstallState;

/// Event names the UI listens to (src/platform/tauri/TauriTransport.ts).
pub const EVENT_RECEIVE: &str = "signal-cli://event";
pub const EVENT_STATE: &str = "signal-cli://state";
/// Download progress for the first-run signal-cli install (`signal_cli_install.rs`).
pub const EVENT_INSTALL_PROGRESS: &str = "signal-cli-install-progress";
/// The close handshake (docs/ENCRYPTION.md, "signal-cli vault"): emitted at
/// the main window's `CloseRequested`, which this module intercepts and
/// prevents so the frontend gets a chance to flush its own last write first.
/// Answered by the `app_close_ready` command.
pub const EVENT_FLUSH_BEFORE_CLOSE: &str = "snowdrop://flush-before-close";
/// How long the close handshake waits for `app_close_ready` before exiting
/// anyway — a frontend that never answers (crashed, stuck, or simply absent
/// in a test harness) must never make the app unclosable.
const CLOSE_FALLBACK: Duration = Duration::from_secs(3);

/// Where signal-cli's data and log live (shown on the About page).
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub log_file: Option<PathBuf>,
}

/// Deduplicates the close handshake's two possible triggers — the frontend
/// answering `app_close_ready`, or [`CLOSE_FALLBACK`] firing first — so only
/// the first one actually exits the app.
pub struct CloseGate(AtomicBool);

impl CloseGate {
    fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// `true` only the first time this is called.
    pub fn fire(&self) -> bool {
        self.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

struct WebviewSink(AppHandle);

impl EventSink for WebviewSink {
    fn event(&self, event: &HeldEvent) {
        if let Err(error) = self.0.emit_to("main", EVENT_RECEIVE, event) {
            log::warn!("couldn't forward a signal-cli event: {error}");
        }
    }

    fn state(&self, state: &StreamState) {
        let _ = self.0.emit_to("main", EVENT_STATE, state);
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    appimage::fix_gstreamer_scanner();
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(notifications::Notifications::default()))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // First thing: `app_log_dir()` needs the `AppHandle`, which
            // doesn't exist before `.setup()` runs, so this is as early as
            // the app-wide logger can be installed. Every `log::` call
            // before this point (none, today) would otherwise go nowhere,
            // same as before this logger existed at all.
            let log_file = app.path().app_log_dir().ok().map(|d| d.join("snowdrop.log"));
            if let Some(log_file) = log_file.clone() {
                applog::install(log_file);
            }
            let handle = app.handle().clone();
            // signal-cli keeps Snowdrop's own data (linked account, keys) apart
            // from any signal-cli you use on the command line.
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            // Holds a downloaded signal-cli and (below) its own data dir; no
            // other local account should be able to read either.
            config::secure_dir(&app_data_dir)?;
            // One-time move of any signal-cli install left at the pre-fix
            // location (`<app_data_dir>/signal-cli/<version>/`), which used
            // to share a folder with signal-cli's own data dir — see
            // `signal_cli_install`'s module docs. Best-effort: a failure here
            // just means the next download re-fetches it.
            if let Err(e) = signal_cli_install::migrate_old_installs(&app_data_dir) {
                log::warn!("signal-cli-install: couldn't migrate an old install to its new location: {e}");
            }
            // Best-effort cleanup of the stale window-state file left behind
            // by the now-removed `tauri_plugin_window_state` plugin: on
            // tiling compositors it restored a "maximized" flag the
            // compositor itself had set for tiling purposes, which made the
            // window come back maximized and cover other tiles.
            if let Ok(config_dir) = app.path().app_config_dir() {
                let _ = std::fs::remove_file(config_dir.join(".window-state.json"));
            }
            let signal_cli_data_override = std::env::var_os("SNOWDROP_SIGNAL_CLI_DATA");
            let data_dir = signal_cli_data_override.clone().map(PathBuf::from).unwrap_or(app_data_dir.join("signal-cli"));
            let paths = Paths {
                app_data_dir: app_data_dir.clone(),
                data_dir: data_dir.clone(),
                bundled: config::bundled_sidecar(),
            };
            app.manage(AppPaths { data_dir, log_file: log_file.clone() });

            // The storage state machine (docs/ENCRYPTION.md): its own lock,
            // its own keys.json, held behind a std Mutex since every command
            // that touches it is a brief, synchronous critical section.
            let storage_paths = storage::StoragePaths::new(app_data_dir.clone(), log_file, signal_cli_data_override.is_some());
            let mut storage_service =
                storage::StorageService::new(storage_paths, secrets::KeyringStore::new(), Box::new(vault::resolve_runtime_dir));
            storage_service.setup()?;

            // The signal-cli vault bridge (docs/ENCRYPTION.md, "signal-cli
            // vault"; task 4b): reaches the storage service it's managed
            // alongside only through two closures, so `vault_bridge` stays
            // independent of `storage::StorageService`'s own shape. Managed
            // as `Mutex<StorageService>` below, same as before this task;
            // these closures look it up lazily through the `AppHandle`
            // rather than capturing it directly, so nothing here has to
            // change how commands.rs reaches it.
            let vault_disabled = signal_cli_data_override.is_some();
            let handle_for_unlock = handle.clone();
            let is_unlocked: vault_bridge::IsUnlocked = Box::new(move || {
                handle_for_unlock.state::<std::sync::Mutex<storage::StorageService>>().lock().expect("storage lock").webcache_key().is_some()
            });
            let handle_for_parts = handle.clone();
            let take_session_parts: vault_bridge::TakeSessionParts = Box::new(move || {
                handle_for_parts.state::<std::sync::Mutex<storage::StorageService>>().lock().expect("storage lock").vault_session_parts()
            });
            let (vault, vault_rx) = vault_bridge::VaultBridge::new(vault_disabled, is_unlocked, take_session_parts);
            tauri::async_runtime::spawn(vault_bridge::run_sync_loop(vault.clone(), vault_rx));

            let service = Service::new(paths, Arc::new(WebviewSink(handle)), vault.clone());

            // Erase hook (docs/ENCRYPTION.md, "Erase"): stop signal-cli, then
            // discard the vault session *without* a final sync — erasing
            // can't be allowed to re-create what it just deleted — before
            // `storage::StorageService::erase_all` deletes the vault and
            // runtime dirs itself.
            let service_for_erase = service.clone();
            let vault_for_erase = vault.clone();
            storage_service.add_on_erase(move || {
                tauri::async_runtime::block_on(service_for_erase.stop_backend());
                vault_for_erase.discard();
            });

            app.manage(service);
            app.manage(std::sync::Mutex::new(storage_service));
            app.manage(Arc::new(InstallState::new(app_data_dir)));
            app.manage(Arc::new(CloseGate::new()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window runs the close handshake; nothing else
            // (e.g. a future secondary window) should delay or prevent exit.
            if window.label() != "main" {
                return;
            }
            let WindowEvent::CloseRequested { api, .. } = event else { return };
            api.prevent_close();
            if let Err(e) = window.emit(EVENT_FLUSH_BEFORE_CLOSE, ()) {
                log::warn!("couldn't notify the frontend before closing: {e}");
            }
            let gate = window.state::<Arc<CloseGate>>().inner().clone();
            let handle = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(CLOSE_FALLBACK).await;
                if gate.fire() {
                    log::warn!("snowdrop: the frontend never answered the close handshake; exiting anyway.");
                    handle.exit(0);
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::clipboard_read_files,
            commands::notification_show,
            commands::notification_close,
            commands::signal_cli_connect,
            commands::signal_cli_request,
            commands::signal_cli_subscribe,
            commands::signal_cli_ack,
            commands::signal_cli_probe,
            commands::signal_cli_locate,
            commands::signal_cli_pinned_release,
            commands::signal_cli_install_status,
            commands::signal_cli_install,
            commands::signal_cli_install_cancel,
            commands::desktop_info,
            commands::open_external,
            commands::storage_keyring_status,
            commands::storage_status,
            commands::storage_setup,
            commands::storage_unlock,
            commands::storage_create_recovery,
            commands::storage_remove_recovery,
            commands::storage_set_passphrase,
            commands::storage_enroll_keyring,
            commands::storage_webcache_key,
            commands::storage_erase_all,
            commands::storage_sign_out,
            commands::app_restart,
            commands::app_close_ready,
            commands::frontend_log,
            commands::log_set_verbose,
            commands::log_recent,
            commands::log_open_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Snowdrop");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Stop signal-cli with the app (closing stdin lets it save first).
            let service = app.state::<Arc<Service>>().inner().clone();
            tauri::async_runtime::block_on(service.shutdown());
        }
    });
}
