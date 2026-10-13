// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must be the very first thing: if this process is the background
    // GStreamer registry-warming child (see `appimage::warm_registry_in_background`),
    // do that and exit instead of starting the real app.
    snowdrop_lib::maybe_run_as_gstreamer_warmup_child();
    snowdrop_lib::run();
}
