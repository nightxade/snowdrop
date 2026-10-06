fn main() {
    // An app manifest makes the app's own commands permission-gated like
    // plugin commands: only those listed in capabilities/main.json are callable.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "signal_cli_connect",
            "signal_cli_request",
            "signal_cli_subscribe",
            "signal_cli_ack",
            "signal_cli_probe",
            "signal_cli_locate",
            "signal_cli_pinned_release",
            "signal_cli_install_status",
            "signal_cli_install",
            "signal_cli_install_cancel",
            "desktop_info",
            "open_external",
            "storage_keyring_status",
            "storage_status",
            "storage_setup",
            "storage_unlock",
            "storage_create_recovery",
            "storage_remove_recovery",
            "storage_set_passphrase",
            "storage_enroll_keyring",
            "storage_webcache_key",
            "storage_erase_all",
            "storage_sign_out",
            "app_restart",
            "app_close_ready",
            "frontend_log",
        ])),
    )
    .expect("failed to run tauri-build");
}
