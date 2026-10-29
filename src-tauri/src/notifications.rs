//! Conversation-keyed desktop notifications. The Tauri plugin discards the
//! freedesktop replacement id, so Linux talks to the notification service here.
//!
//! One notification per conversation tag: showing again replaces it, and the
//! frontend closes it by tag when what it announced no longer applies (the
//! chat was read, the message was deleted). The ids the service handed out are
//! kept for that, and forgotten when the service says the user dismissed one.
//! The connection to the service is opened once and reused.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Default)]
pub struct Notifications {
    #[cfg(target_os = "linux")]
    ids: Arc<Mutex<Ids>>,
    #[cfg(target_os = "linux")]
    link: Mutex<Option<Link>>,
    /// Tests talk to a bus of their own instead of the session bus.
    #[cfg(all(test, target_os = "linux"))]
    bus: Option<String>,
}

/// The id the service gave the notification currently held for each tag.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct Ids {
    by_tag: HashMap<String, u32>,
}

#[cfg(target_os = "linux")]
impl Ids {
    /// The id to replace when showing `tag` again; 0 asks for a new notification.
    fn replacing(&self, tag: &str) -> u32 {
        self.by_tag.get(tag).copied().unwrap_or(0)
    }

    fn shown(&mut self, tag: String, id: u32) {
        self.by_tag.insert(tag, id);
    }

    /// Forgets `tag` and returns the id that has to be closed, if one is held.
    fn take(&mut self, tag: &str) -> Option<u32> {
        self.by_tag.remove(tag)
    }

    /// The service closed notification `id` (the user dismissed it, or it
    /// expired): there is nothing left to replace or close.
    fn closed(&mut self, id: u32) {
        self.by_tag.retain(|_, held| *held != id);
    }
}

/// A live connection to the notification service.
#[cfg(target_os = "linux")]
#[derive(Clone)]
struct Link {
    proxy: zbus::blocking::Proxy<'static>,
    /// The service renders the body as markup, so message text has to be escaped.
    markup: bool,
}

#[cfg(target_os = "linux")]
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(target_os = "linux")]
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
impl Link {
    /// Closes the connection, which ends the watcher thread that listens on it.
    fn shutdown(self) {
        let _ = self.proxy.connection().clone().close();
    }
}

/// Watcher threads running (tests check that a dropped connection ends its own).
#[cfg(all(test, target_os = "linux"))]
static WATCHERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Opens a connection: asks what the service can render, and listens for
/// notifications it closes by itself so their ids are forgotten.
#[cfg(target_os = "linux")]
fn connect(ids: &Arc<Mutex<Ids>>, bus: Option<&str>) -> Result<Link, String> {
    let connection = match bus {
        None => zbus::blocking::Connection::session(),
        Some(address) => zbus::blocking::connection::Builder::address(address)
            .and_then(|builder| builder.build()),
    }
    .map_err(|e| e.to_string())?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )
    .map_err(|e| e.to_string())?;
    // Without markup the text is shown as it is, so escaping would show
    // "&amp;" literally. A service that won't say is assumed to render it:
    // unescaped message text could then inject links.
    let markup = proxy
        .call::<_, _, Vec<String>>("GetCapabilities", &())
        .map_or(true, |caps| caps.iter().any(|c| c == "body-markup"));
    let watcher = proxy.clone();
    let ids = Arc::clone(ids);
    let spawned = std::thread::Builder::new()
        .name("notification-closed".into())
        .spawn(move || watch_closed(&watcher, &ids));
    if let Err(e) = spawned {
        // Only the pruning is lost: a close of a dismissed notification is
        // harmless, and the next show replaces whatever is left.
        log::warn!("notification watcher not started: {e}");
    }
    Ok(Link { proxy, markup })
}

/// Runs until the connection closes.
#[cfg(target_os = "linux")]
fn watch_closed(proxy: &zbus::blocking::Proxy<'static>, ids: &Mutex<Ids>) {
    #[cfg(test)]
    struct Counted;
    #[cfg(test)]
    impl Counted {
        fn start() -> Self {
            WATCHERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Self
        }
    }
    #[cfg(test)]
    impl Drop for Counted {
        fn drop(&mut self) {
            WATCHERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[cfg(test)]
    let _counted = Counted::start();
    let Ok(signals) = proxy.receive_signal("NotificationClosed") else {
        return;
    };
    for signal in signals {
        let Ok((id, _reason)) = signal.body().deserialize::<(u32, u32)>() else {
            continue;
        };
        if let Ok(mut ids) = ids.lock() {
            ids.closed(id);
        }
    }
}

#[cfg(target_os = "linux")]
impl Notifications {
    fn bus(&self) -> Option<&str> {
        #[cfg(test)]
        {
            self.bus.as_deref()
        }
        #[cfg(not(test))]
        {
            None
        }
    }

    /// The connection, opened on first use and after one that failed. The
    /// lock is not held while connecting (a service that hangs would stall
    /// every call behind it); if two callers connect at once the later one
    /// closes its own and uses the first.
    fn link(&self) -> Result<Link, String> {
        if let Some(link) = lock(&self.link)?.as_ref() {
            return Ok(link.clone());
        }
        let opened = connect(&self.ids, self.bus())?;
        let mut slot = lock(&self.link)?;
        if let Some(existing) = slot.as_ref() {
            let existing = existing.clone();
            drop(slot);
            opened.shutdown();
            return Ok(existing);
        }
        *slot = Some(opened.clone());
        Ok(opened)
    }

    /// Describes a failed call. A service that answered with an error is still
    /// there; any other failure means the connection is gone, so the next call
    /// opens a new one.
    fn failed(&self, error: &zbus::Error) -> String {
        if !matches!(error, zbus::Error::MethodError(..)) {
            let gone = self.link.lock().ok().and_then(|mut link| link.take());
            // Ends the old watcher with its connection, instead of leaving both behind.
            if let Some(gone) = gone {
                gone.shutdown();
            }
        }
        error.to_string()
    }

    pub fn show(&self, tag: String, title: String, body: String) -> Result<(), String> {
        let link = self.link()?;
        let replaces = lock(&self.ids)?.replacing(&tag);
        // The notification body supports markup (when the service says so); message content is plain text.
        let body = if link.markup { escape_markup(&body) } else { body };
        let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
        let id: u32 = link
            .proxy
            .call(
                "Notify",
                &(
                    "Snowdrop",
                    replaces,
                    "snowdrop",
                    title,
                    body,
                    Vec::<String>::new(),
                    hints,
                    -1i32,
                ),
            )
            .map_err(|e| self.failed(&e))?;
        lock(&self.ids)?.shown(tag, id);
        Ok(())
    }

    pub fn close(&self, tag: String) -> Result<(), String> {
        let Some(id) = lock(&self.ids)?.take(&tag) else {
            return Ok(());
        };
        match self.link()?.proxy.call::<_, _, ()>("CloseNotification", &(id,)) {
            Ok(()) => Ok(()),
            // The user already dismissed it (or the service dropped it) before
            // the signal reached us: there is nothing left to close.
            Err(zbus::Error::MethodError(..)) => Ok(()),
            Err(e) => Err(self.failed(&e)),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct Received {
        replacements: Vec<u32>,
        bodies: Vec<String>,
        closed: Vec<u32>,
        capabilities: Vec<String>,
        capability_queries: usize,
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

        fn close_notification(&self, id: u32) -> zbus::fdo::Result<()> {
            let mut received = self.0.lock().unwrap();
            received.closed.push(id);
            Ok(())
        }

        fn get_capabilities(&self) -> Vec<String> {
            let mut received = self.0.lock().unwrap();
            received.capability_queries += 1;
            received.capabilities.clone()
        }

        #[zbus(signal)]
        async fn notification_closed(
            ctxt: &zbus::SignalContext<'_>,
            id: u32,
            reason: u32,
        ) -> zbus::Result<()>;
    }

    #[test]
    fn ids_keep_one_notification_per_tag() {
        let mut ids = Ids::default();
        assert_eq!(ids.replacing("ana"), 0);
        ids.shown("ana".into(), 4);
        ids.shown("bo".into(), 5);
        assert_eq!(ids.replacing("ana"), 4);
        // Showing again replaces: the new id takes over (a service may answer with a fresh one).
        ids.shown("ana".into(), 9);
        assert_eq!(ids.replacing("ana"), 9);
        assert_eq!(ids.replacing("bo"), 5);
    }

    #[test]
    fn closing_hands_back_the_id_once() {
        let mut ids = Ids::default();
        ids.shown("ana".into(), 4);
        assert_eq!(ids.take("ana"), Some(4));
        assert_eq!(ids.take("ana"), None);
        assert_eq!(ids.take("never-shown"), None);
        // After a close the next show asks for a new notification.
        assert_eq!(ids.replacing("ana"), 0);
    }

    #[test]
    fn a_notification_the_service_closed_is_forgotten() {
        let mut ids = Ids::default();
        ids.shown("ana".into(), 4);
        ids.shown("bo".into(), 5);
        ids.closed(4);
        assert_eq!(ids.replacing("ana"), 0);
        assert_eq!(ids.take("ana"), None);
        assert_eq!(ids.replacing("bo"), 5);
        // An id nobody holds (already closed by us) changes nothing.
        ids.closed(4);
        ids.closed(77);
        assert_eq!(ids.replacing("bo"), 5);
    }

    #[test]
    fn markup_is_escaped_in_the_right_order() {
        assert_eq!(escape_markup("<a href=\"x\">&amp;</a>"), "&lt;a href=\"x\"&gt;&amp;amp;&lt;/a&gt;");
        assert_eq!(escape_markup("plain"), "plain");
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A private session bus for one test: its own `dbus-daemon`, so nothing
    /// here can reach (or be reached from) the user's desktop.
    struct Bus {
        child: std::process::Child,
        address: String,
    }

    impl Bus {
        /// None where there is no `dbus-daemon` to start.
        fn start() -> Option<Bus> {
            use std::io::{BufRead, BufReader};
            let mut child = std::process::Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address=1"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            let mut address = String::new();
            let read = child
                .stdout
                .take()
                .map(|out| BufReader::new(out).read_line(&mut address));
            if !matches!(read, Some(Ok(n)) if n > 0) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Some(Bus { child, address: address.trim().to_owned() })
        }
    }

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn watchers() -> usize {
        WATCHERS.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn notification_service() {
        let Some(bus) = Bus::start() else {
            eprintln!("skipped: no dbus-daemon to start a private bus with");
            return;
        };
        let received = Arc::new(Mutex::new(Received {
            replacements: Vec::new(),
            bodies: Vec::new(),
            closed: Vec::new(),
            capabilities: vec!["body".into(), "body-markup".into()],
            capability_queries: 0,
        }));
        let server = zbus::blocking::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name("org.freedesktop.Notifications")
            .unwrap()
            .serve_at("/org/freedesktop/Notifications", Desktop(received.clone()))
            .unwrap()
            .build()
            .unwrap();
        let notifications = Notifications { bus: Some(bus.address.clone()), ..Default::default() };
        let idle = watchers();
        notifications.show("ana".into(), "Ana".into(), "first".into()).unwrap();
        notifications.show("ana".into(), "Ana".into(), "<new> & latest".into()).unwrap();
        notifications.show("bo".into(), "Bo".into(), "other".into()).unwrap();
        notifications.close("ana".into()).unwrap();
        // Closing twice, or what was never shown, does nothing.
        notifications.close("ana".into()).unwrap();
        notifications.close("nobody".into()).unwrap();
        notifications.show("ana".into(), "Ana".into(), "again".into()).unwrap();
        {
            let received = received.lock().unwrap();
            assert_eq!(received.replacements, [0, 1, 0, 0]);
            assert_eq!(received.closed, [1]);
            assert_eq!(received.bodies[1], "&lt;new&gt; &amp; latest");
            // One connection, asked once, however many notifications.
            assert_eq!(received.capability_queries, 1);
        }
        wait_until("the watcher to start", || watchers() == idle + 1);

        // The user dismisses Bo's notification: the id is forgotten, so closing
        // it asks the service for nothing and showing again starts a new one.
        let bo = *notifications.ids.lock().unwrap().by_tag.get("bo").unwrap();
        zbus::block_on(async {
            let ctxt = zbus::SignalContext::new(server.inner(), "/org/freedesktop/Notifications")
                .unwrap();
            Desktop::notification_closed(&ctxt, bo, 2).await.unwrap();
        });
        wait_until("the dismissal to be noticed", || {
            notifications.ids.lock().unwrap().replacing("bo") == 0
        });
        notifications.close("bo".into()).unwrap();
        assert_eq!(received.lock().unwrap().closed, [1]);
        notifications.show("bo".into(), "Bo".into(), "back".into()).unwrap();
        assert_eq!(received.lock().unwrap().replacements.last(), Some(&0));

        // A broken connection is replaced, and the old watcher goes with it
        // instead of piling up beside the new one.
        notifications.failed(&zbus::Error::Failure("connection lost".into()));
        wait_until("the old watcher to end", || watchers() == idle);
        notifications.show("cy".into(), "Cy".into(), "reconnected".into()).unwrap();
        wait_until("one watcher again", || watchers() == idle + 1);
        assert_eq!(received.lock().unwrap().capability_queries, 2);
        // A service that answered with an error is still there: the link stays.
        notifications.failed(&zbus::Error::MethodError(
            zbus::names::OwnedErrorName::try_from("org.freedesktop.DBus.Error.Failed").unwrap(),
            None,
            zbus::Message::method("/", "Nothing").unwrap().build(&()).unwrap(),
        ));
        assert!(notifications.link.lock().unwrap().is_some());

        // A service that can't render markup gets the text as it is.
        received.lock().unwrap().capabilities = vec!["body".into()];
        let plain = Notifications { bus: Some(bus.address.clone()), ..Default::default() };
        plain.show("dee".into(), "Dee".into(), "a & b".into()).unwrap();
        assert_eq!(received.lock().unwrap().bodies.last().map(String::as_str), Some("a & b"));
    }
}
