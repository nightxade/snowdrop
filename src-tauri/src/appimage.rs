//! Fix-ups for running inside an AppImage.
//!
//! The AppImage mounts at a fresh random path (`$APPDIR`, e.g.
//! `/tmp/.mount_SnowdreXXXX`) on every launch. GStreamer's plugin registry
//! cache is keyed by plugin path and mtime, so a mount path that's new every
//! time means the very first `gst_init()` of the session — made by WebKit's
//! web process, on its main thread, the first time a page touches media
//! (e.g. opening Settings) — has to rescan every bundled plugin from
//! scratch, stalling the UI for several seconds. Worse, the AppImage's own
//! GStreamer hook points the registry at the *host's* shared
//! `~/.cache/gstreamer-1.0/registry.*.bin`, so this also clobbers that file
//! for the user's other GStreamer apps, which then rescan too.
//!
//! Two fixes, both here: point the registry at a file Snowdrop owns instead
//! of the shared one ([`fix_gstreamer_registry`]), and warm that file in a
//! background child process at startup so the webview's own first
//! `gst_init()` finds an up-to-date cache instead of building one itself
//! ([`warm_registry_in_background`] / [`run_as_warmup_child_if_requested`]).

use std::ffi::{CString, OsStr};
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

/// Env vars GStreamer reads for the 1.0-versioned plugin registry cache
/// (`GST_REGISTRY` is the legacy/unversioned alias GStreamer also honours).
const GST_REGISTRY_1_0: &str = "GST_REGISTRY_1_0";
const GST_REGISTRY: &str = "GST_REGISTRY";

/// `Snowdrop.AppDir`'s app identifier, reused here so Snowdrop's own
/// registry cache lives in a directory named the same way as its other
/// per-user state.
const APP_ID: &str = "local.snowdrop.desktop";

/// Where Snowdrop points the registry when it's safe to (see
/// [`fix_gstreamer_registry`]):
/// `$XDG_CACHE_HOME/local.snowdrop.desktop/gstreamer-1.0/registry.<arch>.bin`,
/// falling back to `$HOME/.cache` the way GStreamer itself falls back when
/// `XDG_CACHE_HOME` is unset. Named `registry.<arch>.bin` to match
/// GStreamer's own naming of the file it replaces.
fn registry_path(xdg_cache_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    let cache = xdg_cache_home.map(Path::to_path_buf).or_else(|| home.map(|h| h.join(".cache")))?;
    Some(cache.join(APP_ID).join("gstreamer-1.0").join(format!("registry.{}.bin", std::env::consts::ARCH)))
}

/// The registry path to switch to, if any: only inside an AppImage
/// (`appdir` is `Some`) and only if the user hasn't already pointed
/// `GST_REGISTRY_1_0` somewhere themselves.
fn registry_override(appdir: Option<&Path>, configured: Option<&Path>, xdg_cache_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    appdir?;
    if configured.is_some() {
        return None;
    }
    registry_path(xdg_cache_home, home)
}

/// Points `GST_REGISTRY_1_0`/`GST_REGISTRY` at a Snowdrop-owned registry
/// file instead of the AppImage hook's default (the host's shared
/// `~/.cache/gstreamer-1.0/registry.*.bin` — see the module docs for why
/// that's a problem). Must run before any threads start, same as
/// [`fix_gstreamer_scanner`]: it sets environment variables that WebKit's
/// web process inherits.
pub fn fix_gstreamer_registry() {
    let appdir = std::env::var_os("APPDIR");
    let configured = std::env::var_os(GST_REGISTRY_1_0);
    let xdg_cache_home = std::env::var_os("XDG_CACHE_HOME");
    let home = std::env::var_os("HOME");
    let Some(path) = registry_override(
        appdir.as_deref().map(Path::new),
        configured.as_deref().map(Path::new),
        xdg_cache_home.as_deref().map(Path::new),
        home.as_deref().map(Path::new),
    ) else {
        return;
    };
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        // Best-effort: GStreamer still works without a writable registry
        // dir, it just can't cache — same as not setting the var at all.
        return;
    }
    std::env::set_var(GST_REGISTRY_1_0, &path);
    std::env::set_var(GST_REGISTRY, &path);
}

/// Private CLI flag that tells this same executable to act as the
/// background registry-warming child (see [`warm_registry_in_background`])
/// instead of starting the real app. Not a public interface — nothing
/// outside this process is meant to pass it.
const WARM_FLAG: &str = "--snowdrop-warm-gstreamer";

/// `$APPDIR/usr/lib/libgstreamer-1.0.so.0` — the actual path `tauri build`
/// (`bundleMediaFramework: true`) puts it at inside `Snowdrop.AppDir`,
/// verified against a real build.
const BUNDLED_LIBGSTREAMER: &str = "usr/lib/libgstreamer-1.0.so.0";

/// If this process was launched as the warm-up child, do the warm-up and
/// exit instead of returning. Must be called at the very top of `main()`,
/// before Tauri or anything else starts: the whole point of the child is
/// to be a short-lived process that never reaches the webview, so it must
/// not pay for (or interfere with) any of the app's own startup, including
/// the single-instance plugin.
pub fn run_as_warmup_child_if_requested() {
    if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(WARM_FLAG)) {
        return;
    }
    std::process::exit(if warm_registry_once() { 0 } else { 1 });
}

/// Loads `libgstreamer-1.0` and calls `gst_init(NULL, NULL)` — the call
/// that actually performs the plugin scan/registry update, i.e. the same
/// work WebKit's web process would otherwise do the first time a page
/// touches media. Returns whether it succeeded. Never panics: a failure
/// here must never be able to affect the real app (see
/// [`run_as_warmup_child_if_requested`]'s caller, which only ever exits a
/// short-lived child process on it).
fn warm_registry_once() -> bool {
    let Some(appdir) = std::env::var_os("APPDIR") else { return false };
    let lib_path = Path::new(&appdir).join(BUNDLED_LIBGSTREAMER);
    let Some(lib_path) = lib_path.to_str() else { return false };
    let Ok(lib_path) = CString::new(lib_path) else { return false };
    let Ok(symbol) = CString::new("gst_init") else { return false };
    // SAFETY: `dlopen`/`dlsym` are called with valid, nul-terminated C
    // strings. The resulting symbol is cast to `gst_init`'s real C
    // signature (`void gst_init(int *argc, char ***argv)`, both pointers
    // nullable) and called with `NULL, NULL`, which is a documented-valid
    // way to call it.
    unsafe {
        let handle = libc::dlopen(lib_path.as_ptr(), libc::RTLD_NOW);
        if handle.is_null() {
            return false;
        }
        let gst_init = libc::dlsym(handle, symbol.as_ptr());
        if gst_init.is_null() {
            return false;
        }
        let gst_init: extern "C" fn(*mut std::ffi::c_int, *mut *mut *mut std::ffi::c_char) = std::mem::transmute(gst_init);
        gst_init(std::ptr::null_mut(), std::ptr::null_mut());
    }
    true
}

/// Spawns a background thread that runs a child copy of this same
/// executable (with [`WARM_FLAG`]) to warm the GStreamer plugin registry
/// once, off the webview's thread, ahead of WebKit's own first
/// `gst_init()` (see module docs). No-op outside an AppImage — a deb or
/// dev build uses the system's already-warm registry.
///
/// Best-effort throughout: this is purely a cache warm-up, so any failure
/// here (the thread, the spawn, the child itself) must never stop or delay
/// the real app starting. The one observable side effect on success or
/// failure is a single `log::info!` line with the duration and outcome.
pub fn warm_registry_in_background() {
    if std::env::var_os("APPDIR").is_none() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    std::thread::spawn(move || {
        use std::os::unix::process::CommandExt;
        let start = std::time::Instant::now();
        let mut command = std::process::Command::new(&exe);
        command.arg(WARM_FLAG).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        // Best-effort low priority: this is background cache warm-up, not
        // user-visible work, and shouldn't compete with WebKit/signal-cli
        // for CPU while it runs. `nice()` failing (e.g. already at a
        // platform-imposed floor) doesn't matter; the child still runs.
        unsafe {
            command.pre_exec(|| {
                libc::nice(10);
                Ok(())
            });
        }
        match command.status() {
            Ok(status) => log::info!("gstreamer registry warm-up finished in {:?}: {status}", start.elapsed()),
            Err(error) => log::info!("gstreamer registry warm-up couldn't start: {error}"),
        }
    });
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

    #[test]
    fn registry_path_prefers_xdg_cache_home_and_names_the_file_by_arch() {
        let xdg = PathBuf::from("/xdg-cache");
        let home = PathBuf::from("/home/someone");
        let path = registry_path(Some(&xdg), Some(&home)).unwrap();
        assert_eq!(path, xdg.join("local.snowdrop.desktop/gstreamer-1.0").join(format!("registry.{}.bin", std::env::consts::ARCH)));
    }

    #[test]
    fn registry_path_falls_back_to_home_cache_without_xdg_cache_home() {
        let home = PathBuf::from("/home/someone");
        let path = registry_path(None, Some(&home)).unwrap();
        assert_eq!(path, home.join(".cache/local.snowdrop.desktop/gstreamer-1.0").join(format!("registry.{}.bin", std::env::consts::ARCH)));
    }

    #[test]
    fn registry_path_is_none_with_neither_xdg_cache_home_nor_home() {
        assert_eq!(registry_path(None, None), None);
    }

    #[test]
    fn registry_override_is_none_outside_an_appimage() {
        let home = PathBuf::from("/home/someone");
        assert_eq!(registry_override(None, None, None, Some(&home)), None);
    }

    #[test]
    fn registry_override_leaves_a_user_configured_registry_alone() {
        let appdir = PathBuf::from("/tmp/.mount_SnowdreXXXX");
        let home = PathBuf::from("/home/someone");
        let configured = PathBuf::from("/some/other/registry.bin");
        assert_eq!(registry_override(Some(&appdir), Some(&configured), None, Some(&home)), None);
    }

    #[test]
    fn registry_override_picks_snowdrops_own_path_in_an_appimage() {
        let appdir = PathBuf::from("/tmp/.mount_SnowdreXXXX");
        let xdg = PathBuf::from("/xdg-cache");
        let expected = registry_path(Some(&xdg), None);
        assert_eq!(registry_override(Some(&appdir), None, Some(&xdg), None), expected);
        assert!(expected.is_some());
    }
}
