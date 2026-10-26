//! Microphone permission for voice notes.
//!
//! The webview asks for the microphone with `getUserMedia`; WebKitGTK then
//! raises a permission request that nothing answers unless the app does
//! (wry forwards it to Tauri's `on_permission_request`). The answer here is
//! "yes, once, only just after a real click or key press", and "no" to
//! everything else (camera, screen capture, location, …).
//!
//! The page can't be the witness of its own gesture (it's the thing being
//! distrusted), so the *native* side watches: GTK button and key events on the
//! webview open a short window that one microphone grant may spend. Script
//! can't forge those events (a `dispatchEvent` never reaches GTK), so a page
//! that was merely loaded, or is running in the background, can't open the
//! microphone on its own.
//!
//! What this doesn't stop: script that waits for any click or key press of
//! the user's and requests the microphone in the next few seconds. The
//! recorder's own indicator is on screen whenever the microphone is open.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use std::sync::Arc;
use tauri::webview::{PermissionKind, PermissionResponse};

/// How long after a click or key press one microphone request is allowed.
/// Opening the recorder asks for the microphone before anything slow runs.
pub const GESTURE_WINDOW: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct MicGate {
    allowed_until: Mutex<Option<Instant>>,
}

impl MicGate {
    /// Opens (or extends, never shortens) the window until `now + GESTURE_WINDOW`.
    pub fn open(&self, now: Instant) {
        let until = now + GESTURE_WINDOW;
        let mut slot = self.allowed_until.lock().expect("mic gate lock");
        match *slot {
            Some(current) if current >= until => {}
            _ => *slot = Some(until),
        }
    }

    /// Spends the gesture: true (once) while a window is open.
    pub fn take(&self, now: Instant) -> bool {
        let mut slot = self.allowed_until.lock().expect("mic gate lock");
        let open = slot.is_some_and(|until| now <= until);
        *slot = None;
        open
    }
}

/// The answer to one webview permission request: the microphone inside a
/// gesture window, nothing else, ever.
pub fn decide(kind: PermissionKind, gate: &MicGate, now: Instant) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone if gate.take(now) => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

/// Hooks the webview's native button and key events to `gate`. Must run on
/// the GTK main thread (Tauri's `with_webview` does).
#[cfg(target_os = "linux")]
pub fn watch(webview: &webkit2gtk::WebView, gate: Arc<MicGate>) {
    use gtk::prelude::*;
    let key_gate = gate.clone();
    webview.connect_key_press_event(move |_, _| {
        key_gate.open(Instant::now());
        gtk::glib::Propagation::Proceed
    });
    webview.connect_button_press_event(move |_, _| {
        gate.open(Instant::now());
        gtk::glib::Propagation::Proceed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_the_microphone_until_a_gesture_opens_the_gate() {
        let gate = MicGate::default();
        let t0 = Instant::now();
        assert!(matches!(decide(PermissionKind::Microphone, &gate, t0), PermissionResponse::Deny));
        gate.open(t0);
        assert!(matches!(decide(PermissionKind::Microphone, &gate, t0), PermissionResponse::Allow));
    }

    #[test]
    fn one_gesture_buys_one_grant() {
        let gate = MicGate::default();
        let t0 = Instant::now();
        gate.open(t0);
        assert!(matches!(decide(PermissionKind::Microphone, &gate, t0), PermissionResponse::Allow));
        assert!(matches!(decide(PermissionKind::Microphone, &gate, t0), PermissionResponse::Deny));
    }

    #[test]
    fn a_stale_gesture_is_not_honoured() {
        let gate = MicGate::default();
        let t0 = Instant::now();
        gate.open(t0);
        let late = t0 + GESTURE_WINDOW + Duration::from_millis(1);
        assert!(matches!(decide(PermissionKind::Microphone, &gate, late), PermissionResponse::Deny));
    }

    #[test]
    fn grants_nothing_but_the_microphone_and_a_refusal_keeps_the_gesture() {
        let gate = MicGate::default();
        let t0 = Instant::now();
        gate.open(t0);
        for kind in [
            PermissionKind::Camera,
            PermissionKind::DisplayCapture,
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
        ] {
            assert!(matches!(decide(kind, &gate, t0), PermissionResponse::Deny));
        }
        // Refusing the others leaves the user's click for the microphone request.
        assert!(matches!(decide(PermissionKind::Microphone, &gate, t0), PermissionResponse::Allow));
    }

    #[test]
    fn a_later_gesture_never_shortens_the_window() {
        let gate = MicGate::default();
        let t0 = Instant::now();
        gate.open(t0 + Duration::from_secs(2));
        gate.open(t0);
        assert!(gate.take(t0 + Duration::from_secs(6)));
    }
}
