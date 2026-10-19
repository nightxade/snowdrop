//! Conversation-keyed desktop notifications. The Tauri plugin discards the
//! freedesktop replacement id, so Linux talks to the notification service here.
//!
//! Linux also owns the click path end to end: `show` asks for the
//! `"default"` action, and `spawn_click_listener` runs for the app's
//! lifetime on its own thread, translating the server's `ActionInvoked`
//! (and `NotificationClosed`) signals back into a `tag` the frontend
//! understands. Other platforms have no click callback to hook — see
//! docs/DESKTOP.md, "System tray and badges".

#[cfg(target_os = "linux")]
use std::collections::HashMap;

#[derive(Default)]
pub struct Notifications {
    #[cfg(target_os = "linux")]
    ids: std::sync::Mutex<HashMap<String, u32>>,
    /// The reverse direction (id → tag) plus pending activation tokens, for
    /// the click listener below. Separate from `ids` above, and from the
    /// zbus plumbing around it, so this bookkeeping is a plain data
    /// structure a test can drive with no D-Bus connection at all.
    #[cfg(target_os = "linux")]
    click: std::sync::Mutex<ClickMap>,
}

#[cfg(target_os = "linux")]
impl Notifications {
    pub fn show(&self, tag: String, title: String, body: String) -> Result<(), String> {
        let mut ids = self.ids.lock().map_err(|e| e.to_string())?;
        let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
        let proxy = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .map_err(|e| e.to_string())?;
        // The notification body supports markup; message content is plain text.
        let body = body
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
        // "default" is the action a plain click on the notification body (or
        // the only button some servers render for it) invokes; the second
        // string of each pair is its label, shown only on servers that
        // render actions as buttons rather than treating "default" as the
        // whole-notification click.
        let actions = vec!["default".to_string(), "Open".to_string()];
        let id: u32 = proxy
            .call("Notify", &(
                "Snowdrop",
                ids.get(&tag).copied().unwrap_or(0),
                "snowdrop",
                title,
                body,
                actions,
                hints,
                -1i32,
            ))
            .map_err(|e| e.to_string())?;
        if let Ok(mut click) = self.click.lock() {
            click.remember(id, tag.clone());
        }
        ids.insert(tag, id);
        Ok(())
    }

    pub fn close(&self, tag: String) -> Result<(), String> {
        let mut ids = self.ids.lock().map_err(|e| e.to_string())?;
        let Some(id) = ids.get(&tag).copied() else {
            return Ok(());
        };
        let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
        let proxy = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .map_err(|e| e.to_string())?;
        proxy
            .call::<_, _, ()>("CloseNotification", &(id,))
            .map_err(|e| e.to_string())?;
        ids.remove(&tag);
        Ok(())
    }

    /// The tag `id` was last shown under, for the click listener's
    /// `ActionInvoked` handler. `None` once the id has been forgotten
    /// (`forget_closed`) or was never ours.
    fn tag_for_click(&self, id: u32) -> Option<String> {
        self.click.lock().ok()?.tag_of(id)
    }

    /// Remembers an `ActivationToken` signal (Notifications spec 1.2) ahead
    /// of the `ActionInvoked` it precedes, for `activate_with_token` to use
    /// once the click itself arrives.
    fn set_activation_token(&self, id: u32, token: String) {
        if let Ok(mut click) = self.click.lock() {
            click.set_token(id, token);
        }
    }

    /// Takes (and clears) the token stored for `id` — a token is single-use,
    /// and this app only ever wants the latest one.
    fn take_activation_token(&self, id: u32) -> Option<String> {
        self.click.lock().ok()?.take_token(id)
    }

    /// `NotificationClosed`: the server will never report a click on this id
    /// again, so drop everything kept about it.
    fn forget_closed(&self, id: u32) {
        if let Ok(mut click) = self.click.lock() {
            click.forget(id);
        }
    }
}

/// Pure id↔tag bookkeeping for the click listener (the reverse of `ids`
/// above, since the desktop reports clicks and closes by id, not tag).
#[cfg(target_os = "linux")]
#[derive(Default)]
struct ClickMap {
    tag_by_id: HashMap<u32, String>,
    token_by_id: HashMap<u32, String>,
}

#[cfg(target_os = "linux")]
impl ClickMap {
    fn remember(&mut self, id: u32, tag: String) {
        self.tag_by_id.insert(id, tag);
    }

    fn tag_of(&self, id: u32) -> Option<String> {
        self.tag_by_id.get(&id).cloned()
    }

    fn set_token(&mut self, id: u32, token: String) {
        self.token_by_id.insert(id, token);
    }

    fn take_token(&mut self, id: u32) -> Option<String> {
        self.token_by_id.remove(&id)
    }

    fn forget(&mut self, id: u32) {
        self.tag_by_id.remove(&id);
        self.token_by_id.remove(&id);
    }
}

/// Which signal `member` names, among the ones this app listens for — a
/// plain string match, so it's testable with no D-Bus message involved.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClickSignal {
    ActionInvoked,
    ActivationToken,
    NotificationClosed,
}

#[cfg(target_os = "linux")]
fn classify_signal(member: &str) -> Option<ClickSignal> {
    match member {
        "ActionInvoked" => Some(ClickSignal::ActionInvoked),
        "ActivationToken" => Some(ClickSignal::ActivationToken),
        "NotificationClosed" => Some(ClickSignal::NotificationClosed),
        _ => None,
    }
}

/// The `"default"` action (requested by `show`, above) is a plain click on
/// the notification; any other key would be a more specific action this
/// app doesn't define, so it's ignored rather than treated as a click.
#[cfg(target_os = "linux")]
fn is_default_action(action_key: &str) -> bool {
    action_key == "default"
}

/// Runs for the app's lifetime on its own thread (the underlying zbus call
/// blocks, same as `show`/`close`'s own connections — there's just nothing
/// to return here). Translates `ActionInvoked` into [`EVENT_NOTIFICATION_CLICKED`]
/// (`crate::focus_main` first, so the window is already in front when the
/// frontend's listener runs) and `NotificationClosed`/`ActivationToken` into
/// the bookkeeping above. A connection failure (no session bus, e.g. a
/// headless test environment) just means clicks are never reported —
/// `show`/`close` already tolerate the same thing per-call.
#[cfg(target_os = "linux")]
pub fn spawn_click_listener(app: tauri::AppHandle, notifications: std::sync::Arc<Notifications>) {
    std::thread::spawn(move || {
        let connection = match zbus::blocking::Connection::session() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("snowdrop: notification click listener couldn't reach the session bus: {e}");
                return;
            }
        };
        let proxy = match zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        ) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("snowdrop: notification click listener couldn't create its proxy: {e}");
                return;
            }
        };
        let signals = match proxy.receive_all_signals() {
            Ok(s) => s,
            Err(e) => {
                log::warn!("snowdrop: notification click listener couldn't subscribe to signals: {e}");
                return;
            }
        };
        for message in signals {
            let Some(member) = message.header().member().cloned() else { continue };
            let Some(kind) = classify_signal(member.as_str()) else { continue };
            match kind {
                ClickSignal::ActionInvoked => {
                    let Ok((id, action_key)) = message.body().deserialize::<(u32, String)>() else { continue };
                    if !is_default_action(&action_key) {
                        continue;
                    }
                    let Some(tag) = notifications.tag_for_click(id) else { continue };
                    let token = notifications.take_activation_token(id);
                    on_clicked(&app, tag, token);
                }
                ClickSignal::ActivationToken => {
                    let Ok((id, token)) = message.body().deserialize::<(u32, String)>() else { continue };
                    notifications.set_activation_token(id, token);
                }
                ClickSignal::NotificationClosed => {
                    let Ok((id, _reason)) = message.body().deserialize::<(u32, u32)>() else { continue };
                    notifications.forget_closed(id);
                }
            }
        }
    });
}

/// Everything a click needs to happen on the main thread together — raising
/// the window (with the Wayland activation hint, best-effort) must run
/// there regardless, so `focus_main` and the frontend event ride along with
/// it rather than adding a second hop.
#[cfg(target_os = "linux")]
fn on_clicked(app: &tauri::AppHandle, tag: String, token: Option<String>) {
    use tauri::Emitter;
    let main_thread_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(token) = &token {
            activate_with_token(&main_thread_app, token);
        }
        crate::focus_main(&main_thread_app);
        if let Err(e) = main_thread_app.emit_to("main", crate::EVENT_NOTIFICATION_CLICKED, &tag) {
            log::warn!("snowdrop: couldn't tell the frontend which conversation was clicked: {e}");
        }
    });
}

/// Best-effort Wayland focus fix: `focus_main`'s `show`/`set_focus` already
/// raise the window correctly on X11 and everywhere else, but GNOME/KDE on
/// Wayland otherwise just flash the taskbar entry for a window an idle app
/// tries to raise on its own. Compositors that honour the activation-token
/// protocol instead raise it for real once GTK presents the window with a
/// valid activation token as its startup id — which only exists when
/// the notification server actually sent one (`ActivationToken`, spec
/// 1.2); most servers don't, and this is simply a no-op then.
#[cfg(target_os = "linux")]
fn activate_with_token(app: &tauri::AppHandle, token: &str) {
    use gtk::prelude::*;
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(gtk_window) = window.gtk_window() else { return };
    // GTK3 hands a window's startup id to the compositor as its
    // xdg-activation token on Wayland (startup notification on X11), so the
    // next `present()` is a real activation rather than an attention flash.
    // Not `XDG_ACTIVATION_TOKEN`: mutating the environment while other
    // threads (the async runtime, signal-cli spawns) may read it is unsound.
    gtk_window.set_startup_id(token);
    gtk_window.present();
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Received {
        replacements: Vec<u32>,
        bodies: Vec<String>,
        actions: Vec<Vec<String>>,
        closed: Vec<u32>,
    }

    struct Desktop(Arc<Mutex<Received>>);

    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl Desktop {
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &self,
            _app_name: &str,
            replaces_id: u32,
            _app_icon: &str,
            _summary: &str,
            body: &str,
            actions: Vec<String>,
            _hints: HashMap<String, zbus::zvariant::OwnedValue>,
            _expire_timeout: i32,
        ) -> u32 {
            let mut received = self.0.lock().unwrap();
            received.replacements.push(replaces_id);
            received.bodies.push(body.to_owned());
            received.actions.push(actions);
            if replaces_id == 0 {
                received.replacements.len() as u32
            } else {
                replaces_id
            }
        }

        fn close_notification(&self, id: u32) {
            self.0.lock().unwrap().closed.push(id);
        }
    }

    /// Run with `dbus-run-session -- cargo test notification_replacement -- --ignored`.
    /// A private bus prevents this test from sending or closing real notifications.
    #[test]
    #[ignore = "requires a private D-Bus session"]
    fn notification_replacement() {
        let received = Arc::new(Mutex::new(Received::default()));
        let _server = zbus::blocking::connection::Builder::session().unwrap()
            .name("org.freedesktop.Notifications").unwrap()
            .serve_at("/org/freedesktop/Notifications", Desktop(received.clone())).unwrap()
            .build().unwrap();
        let notifications = Notifications::default();
        notifications.show("ana".into(), "Ana".into(), "first".into()).unwrap();
        notifications.show("ana".into(), "Ana".into(), "<new> & latest".into()).unwrap();
        notifications.show("bo".into(), "Bo".into(), "other".into()).unwrap();
        notifications.close("ana".into()).unwrap();
        notifications.show("ana".into(), "Ana".into(), "again".into()).unwrap();
        let received = received.lock().unwrap();
        assert_eq!(received.replacements, [0, 1, 0, 0]);
        assert_eq!(received.closed, [1]);
        assert_eq!(received.bodies[1], "&lt;new&gt; &amp; latest");
        assert!(received.actions.iter().all(|a| a == &["default", "Open"]));
    }

    // ─── Click bookkeeping and signal parsing (pure; no D-Bus needed) ──────

    #[test]
    fn click_map_remembers_the_tag_an_id_was_shown_under() {
        let mut click = ClickMap::default();
        assert_eq!(click.tag_of(7), None);
        click.remember(7, "ana".into());
        assert_eq!(click.tag_of(7), Some("ana".to_string()));
        // A later `show` reusing the same id (a replacement) just overwrites it.
        click.remember(7, "bo".into());
        assert_eq!(click.tag_of(7), Some("bo".to_string()));
    }

    #[test]
    fn click_map_forgets_everything_about_a_closed_id() {
        let mut click = ClickMap::default();
        click.remember(7, "ana".into());
        click.set_token(7, "token-1".into());
        click.forget(7);
        assert_eq!(click.tag_of(7), None);
        assert_eq!(click.take_token(7), None);
    }

    #[test]
    fn click_map_token_is_taken_once() {
        let mut click = ClickMap::default();
        click.set_token(7, "token-1".into());
        assert_eq!(click.take_token(7), Some("token-1".to_string()));
        assert_eq!(click.take_token(7), None);
    }

    #[test]
    fn click_map_ids_are_independent() {
        let mut click = ClickMap::default();
        click.remember(1, "ana".into());
        click.remember(2, "bo".into());
        click.forget(1);
        assert_eq!(click.tag_of(1), None);
        assert_eq!(click.tag_of(2), Some("bo".to_string()));
    }

    #[test]
    fn classifies_the_three_signals_this_app_listens_for() {
        assert_eq!(classify_signal("ActionInvoked"), Some(ClickSignal::ActionInvoked));
        assert_eq!(classify_signal("ActivationToken"), Some(ClickSignal::ActivationToken));
        assert_eq!(classify_signal("NotificationClosed"), Some(ClickSignal::NotificationClosed));
    }

    #[test]
    fn ignores_every_other_signal_name() {
        assert_eq!(classify_signal("PropertiesChanged"), None);
        assert_eq!(classify_signal(""), None);
        assert_eq!(classify_signal("actioninvoked"), None); // case-sensitive
    }

    #[test]
    fn only_the_default_action_is_a_click() {
        assert!(is_default_action("default"));
        assert!(!is_default_action("Open"));
        assert!(!is_default_action("Default")); // case-sensitive
        assert!(!is_default_action(""));
    }
}
