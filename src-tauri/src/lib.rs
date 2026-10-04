//! Snowdrop's desktop shell (Tauri v2): one window running the web UI, and
//! the signal-cli connection the UI drives through a handful of commands.
//! See docs/DESKTOP.md.

pub mod aead;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod external;
pub mod jsonrpc;
pub mod keyslots;
pub mod logfile;
pub mod process;
pub mod secrets;
pub mod service;
pub mod signal_cli_install;
pub mod vault;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::events::HeldEvent;
use crate::service::{EventSink, Paths, Service, StreamState};
use crate::signal_cli_install::InstallState;

/// Event names the UI listens to (src/platform/tauri/TauriTransport.ts).
pub const EVENT_RECEIVE: &str = "signal-cli://event";
pub const EVENT_STATE: &str = "signal-cli://state";
/// Download progress for the first-run signal-cli install (`signal_cli_install.rs`).
pub const EVENT_INSTALL_PROGRESS: &str = "signal-cli-install-progress";

/// Where signal-cli's data and log live (shown on the About page).
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub log_file: Option<PathBuf>,
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
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // signal-cli keeps Snowdrop's own data (linked account, keys) apart
            // from any signal-cli you use on the command line.
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            // Holds a downloaded signal-cli and (below) its own data dir; no
            // other local account should be able to read either.
            config::secure_dir(&app_data_dir)?;
            let data_dir = std::env::var_os("SNOWDROP_SIGNAL_CLI_DATA")
                .map(PathBuf::from)
                .unwrap_or(app_data_dir.join("signal-cli"));
            let log_file = app.path().app_log_dir().ok().map(|d| d.join("signal-cli.log"));
            let paths = Paths {
                app_data_dir: app_data_dir.clone(),
                data_dir: data_dir.clone(),
                log_file: log_file.clone(),
                bundled: config::bundled_sidecar(),
            };
            app.manage(AppPaths { data_dir, log_file });
            app.manage(Service::new(paths, Arc::new(WebviewSink(handle))));
            app.manage(Arc::new(InstallState::new(app_data_dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
