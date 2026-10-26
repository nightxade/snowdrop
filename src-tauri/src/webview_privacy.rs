//! WebKitGTK settings that keep the webview from making network requests
//! nobody asked for.
//!
//! DNS prefetching resolves the host of every visible link ahead of a click,
//! which would tell a DNS resolver which sites appear in your chats. The page
//! also carries `<meta http-equiv="x-dns-prefetch-control" content="off">`
//! (index.html); this turns the engine feature off outright where the engine
//! still has one (recent WebKitGTK builds have deprecated the setting and
//! never prefetch, so it reads back as off regardless).

/// Applies the settings to `settings` and returns whether DNS prefetching
/// reads back as disabled.
#[cfg(target_os = "linux")]
pub fn apply(settings: &webkit2gtk::Settings) -> bool {
    use webkit2gtk::SettingsExt;
    settings.set_enable_dns_prefetching(false);
    // `getUserMedia` (voice notes) only exists with this on; every request it
    // raises is answered by `mic_gate.rs`, which grants the microphone alone.
    settings.set_enable_media_stream(true);
    !settings.enables_dns_prefetching()
}

/// Applies [`apply`] to the main window's webview (run on the GTK main
/// thread by Tauri), logs the verified result, and starts watching its native
/// paste gestures for `gate` (see `paste_gate.rs`).
#[cfg(target_os = "linux")]
pub fn configure_main_window(
    app: &tauri::AppHandle,
    gate: std::sync::Arc<crate::paste_gate::PasteGate>,
    mic_gate: std::sync::Arc<crate::mic_gate::MicGate>,
) {
    use tauri::Manager;
    use webkit2gtk::WebViewExt;
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("webview privacy: no main window to configure");
        return;
    };
    let result = window.with_webview(move |webview| {
        crate::paste_gate::watch(&webview.inner(), gate);
        crate::mic_gate::watch(&webview.inner(), mic_gate);
        let off = webview.inner().settings().is_some_and(|settings| apply(&settings));
        if off {
            log::debug!("webview privacy: DNS prefetching is disabled");
        } else {
            log::warn!("webview privacy: could not confirm DNS prefetching is disabled");
        }
    });
    if let Err(error) = result {
        log::warn!("webview privacy: couldn't reach the webview ({error})");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn configure_main_window(
    _app: &tauri::AppHandle,
    _gate: std::sync::Arc<crate::paste_gate::PasteGate>,
    _mic_gate: std::sync::Arc<crate::mic_gate::MicGate>,
) {
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use webkit2gtk::SettingsExt;

    #[test]
    fn turns_dns_prefetching_off_and_reads_it_back() {
        // GTK needs a display even to create a settings object; on a headless
        // box this can't run (the runtime path logs its own verification).
        if gtk::init().is_err() {
            eprintln!("skipped: no display for GTK");
            return;
        }
        let settings = webkit2gtk::Settings::new();
        // Newer WebKitGTK builds deprecate the property and always read it
        // back as off; older ones honour it. Either way it must end up off.
        settings.set_enable_dns_prefetching(true);
        assert!(super::apply(&settings));
        assert!(!settings.enables_dns_prefetching());
    }
}
