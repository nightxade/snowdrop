//! Fix-ups for running inside an AppImage.

use std::path::{Path, PathBuf};

/// Where Tauri's AppImage bundler actually puts GStreamer's plugin scanner.
const BUNDLED_SCANNER: &str = "usr/lib/gstreamer-1.0/gst-plugin-scanner";

/// The AppImage's GStreamer hook points `GST_PLUGIN_SCANNER_1_0` at a
/// Debian-style path that the bundler doesn't populate, so every plugin
/// scan warns "External plugin loader failed" (and falls back to scanning
/// in-process). Point it at the scanner that is bundled. Must run before
/// any threads start: it sets environment variables that WebKit's web
/// process inherits.
pub fn fix_gstreamer_scanner() {
    let Some(appdir) = std::env::var_os("APPDIR") else { return };
    let configured = std::env::var_os("GST_PLUGIN_SCANNER_1_0");
    if let Some(scanner) = scanner_override(Path::new(&appdir), configured.as_deref().map(Path::new)) {
        std::env::set_var("GST_PLUGIN_SCANNER_1_0", &scanner);
        std::env::set_var("GST_PLUGIN_SCANNER", &scanner);
    }
}

/// The scanner to use instead of `configured`, if `configured` is missing
/// and the bundled one exists.
fn scanner_override(appdir: &Path, configured: Option<&Path>) -> Option<PathBuf> {
    if configured.is_some_and(Path::is_file) {
        return None;
    }
    let bundled = appdir.join(BUNDLED_SCANNER);
    bundled.is_file().then_some(bundled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_a_missing_scanner_with_the_bundled_one() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join(BUNDLED_SCANNER);
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"").unwrap();
        let missing = dir.path().join("usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner");
        assert_eq!(scanner_override(dir.path(), Some(&missing)), Some(bundled.clone()));
        assert_eq!(scanner_override(dir.path(), None), Some(bundled.clone()));
        // A configured scanner that exists is left alone.
        assert_eq!(scanner_override(dir.path(), Some(&bundled)), None);
    }

    #[test]
    fn does_nothing_without_a_bundled_scanner() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(scanner_override(dir.path(), None), None);
    }
}
