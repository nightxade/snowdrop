//! Conversation-keyed desktop notifications. The Tauri plugin discards the
//! freedesktop replacement id, so Linux talks to the notification service here.

#[cfg(target_os = "linux")]
use std::collections::HashMap;

#[derive(Default)]
pub struct Notifications {
    #[cfg(target_os = "linux")]
    ids: std::sync::Mutex<HashMap<String, u32>>,
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
        let id: u32 = proxy
            .call("Notify", &(
                "Snowdrop",
                ids.get(&tag).copied().unwrap_or(0),
                "snowdrop",
                title,
                body,
                Vec::<String>::new(),
                hints,
                -1i32,
            ))
            .map_err(|e| e.to_string())?;
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
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Received {
        replacements: Vec<u32>,
        bodies: Vec<String>,
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
            _actions: Vec<String>,
            _hints: HashMap<String, zbus::zvariant::OwnedValue>,
            _expire_timeout: i32,
        ) -> u32 {
            let mut received = self.0.lock().unwrap();
            received.replacements.push(replaces_id);
            received.bodies.push(body.to_owned());
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
    }
}
