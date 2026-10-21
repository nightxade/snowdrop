//! Proof of a recent, real paste gesture for `clipboard_read_files`.
//!
//! That command returns the contents of any file on the clipboard. Called by
//! compromised page script, it'd be a way to read whatever the user last
//! copied in a file manager, with no gesture at all. The page can't be the
//! witness (it's the thing being distrusted), so the *native* side watches:
//! GTK key events on the webview (Ctrl+V, Ctrl+Shift+V, Shift+Insert) and the
//! webview's context menu opening (its "Paste" item) open a short window, and
//! the command refuses outside it. Script can't forge those events (a
//! `dispatchEvent` never reaches GTK).
//!
//! What this doesn't stop: script that waits for the user's own paste and
//! then reads the clipboard in that window (it only learns what the user was
//! pasting anyway), or a pasted file the user didn't mean to be read at all.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after a paste keystroke the command is allowed.
pub const KEY_WINDOW: Duration = Duration::from_secs(5);
/// How long after the context menu opens (the user may take a while to pick
/// "Paste", or not pick it at all).
pub const MENU_WINDOW: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct PasteGate {
    allowed_until: Mutex<Option<Instant>>,
}

impl PasteGate {
    /// Opens (or extends, never shortens) the window until `now + window`.
    pub fn open(&self, now: Instant, window: Duration) {
        let until = now + window;
        let mut slot = self.allowed_until.lock().expect("paste gate lock");
        match *slot {
            Some(current) if current >= until => {}
            _ => *slot = Some(until),
        }
    }

    /// Whether `now` is inside a window.
    pub fn is_open(&self, now: Instant) -> bool {
        self.allowed_until.lock().expect("paste gate lock").is_some_and(|until| now <= until)
    }

    /// Closes the window (a read consumes the gesture that allowed it).
    pub fn close(&self) {
        *self.allowed_until.lock().expect("paste gate lock") = None;
    }
}

/// Ctrl+V, Ctrl+Shift+V or Shift+Insert. `keycode` is the hardware key (55 is
/// `V` on X11 and Wayland), so it also works on non-Latin layouts where the
/// keyval for that key isn't `v`.
#[cfg(target_os = "linux")]
pub fn is_paste_shortcut(keyval: &gtk::gdk::keys::Key, keycode: u16, state: gtk::gdk::ModifierType) -> bool {
    use gtk::gdk::keys::constants as k;
    use gtk::gdk::ModifierType as M;
    let alt_or_super = state.intersects(M::MOD1_MASK | M::SUPER_MASK | M::META_MASK);
    if alt_or_super {
        return false;
    }
    let ctrl_v = state.contains(M::CONTROL_MASK) && (*keyval == k::v || *keyval == k::V || keycode == 55);
    let shift_insert = state.contains(M::SHIFT_MASK) && !state.contains(M::CONTROL_MASK) && *keyval == k::Insert;
    ctrl_v || shift_insert
}

/// Hooks the webview's native key and context-menu events to `gate`. Must run
/// on the GTK main thread (Tauri's `with_webview` does).
#[cfg(target_os = "linux")]
pub fn watch(webview: &webkit2gtk::WebView, gate: std::sync::Arc<PasteGate>) {
    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;
    let key_gate = gate.clone();
    webview.connect_key_press_event(move |_, event| {
        if is_paste_shortcut(&event.keyval(), event.hardware_keycode(), event.state()) {
            key_gate.open(Instant::now(), KEY_WINDOW);
        }
        gtk::glib::Propagation::Proceed
    });
    webview.connect_context_menu(move |_, _, _, _| {
        gate.open(Instant::now(), MENU_WINDOW);
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_until_a_gesture_opens_it() {
        let gate = PasteGate::default();
        let t0 = Instant::now();
        assert!(!gate.is_open(t0));
        gate.open(t0, KEY_WINDOW);
        assert!(gate.is_open(t0));
        assert!(gate.is_open(t0 + KEY_WINDOW));
        assert!(!gate.is_open(t0 + KEY_WINDOW + Duration::from_millis(1)));
    }

    #[test]
    fn a_shorter_gesture_never_shortens_a_longer_window() {
        let gate = PasteGate::default();
        let t0 = Instant::now();
        gate.open(t0, MENU_WINDOW);
        gate.open(t0, KEY_WINDOW);
        assert!(gate.is_open(t0 + KEY_WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn closing_consumes_the_gesture() {
        let gate = PasteGate::default();
        let t0 = Instant::now();
        gate.open(t0, KEY_WINDOW);
        gate.close();
        assert!(!gate.is_open(t0));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recognises_paste_shortcuts_only() {
        use gtk::gdk::keys::constants as k;
        use gtk::gdk::ModifierType as M;
        assert!(is_paste_shortcut(&k::v, 55, M::CONTROL_MASK));
        assert!(is_paste_shortcut(&k::V, 55, M::CONTROL_MASK | M::SHIFT_MASK));
        assert!(is_paste_shortcut(&k::Cyrillic_em, 55, M::CONTROL_MASK));
        assert!(is_paste_shortcut(&k::Insert, 118, M::SHIFT_MASK));
        assert!(!is_paste_shortcut(&k::v, 55, M::empty()));
        assert!(!is_paste_shortcut(&k::c, 54, M::CONTROL_MASK));
        assert!(!is_paste_shortcut(&k::v, 55, M::CONTROL_MASK | M::MOD1_MASK));
        assert!(!is_paste_shortcut(&k::Insert, 118, M::empty()));
        assert!(!is_paste_shortcut(&k::a, 38, M::SHIFT_MASK));
    }
}
