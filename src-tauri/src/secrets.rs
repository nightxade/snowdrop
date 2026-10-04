//! The keyring slot: a random 32-byte secret stored in the platform's
//! credential store, which wraps the vault's DEK (docs/ENCRYPTION.md, "Key
//! hierarchy"). `SecretStore` is the seam between that logic and the actual
//! OS keyring, so `KeyringSlot` is tested against an in-memory fake and a
//! real keyring is never touched in tests.
//!
//! Every enrolment gets its own randomly named keyring account
//! (`keyslot-<entry>`), not a single fixed one: [`KeyringSlot::create_new`]
//! never overwrites anything, so a late write from a timed-out call can only
//! ever land on an account nothing references, and `keys.json`'s own
//! `entry` field (see `keyslots.rs`) says which one is current.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use crate::aead::Key32;
use crate::error::{Error, ErrorKind};

/// freedesktop Secret Service terms; also used as the macOS Keychain
/// service name and the Windows Credential Manager target name.
pub const SERVICE: &str = "local.snowdrop.desktop";

/// Every account this service ever creates starts with this prefix.
const ACCOUNT_PREFIX: &str = "keyslot-";

/// A fixed, never-written account used only by [`status`] to probe whether
/// the keyring answers at all, independent of any real enrolment.
const STATUS_PROBE_ACCOUNT: &str = "keyslot-status-probe";

/// How long the fast "is anything there at all" probe
/// ([`probe_session_bus`]) waits before giving up: a backend that's
/// genuinely absent (e.g. a bare Hyprland session with no Secret Service on
/// the bus) must fail fast, not hang for the long timeout below.
const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(2);

/// How long an actual get/set/delete may take once the probe says something
/// is there: generous, because a *locked* wallet shows the user its own
/// unlock prompt, which can legitimately take a while to answer.
const KEYRING_TIMEOUT: Duration = Duration::from_secs(120);

/// This enrolment's keyring account name (docs/ENCRYPTION.md: `keyslot-<entry>`).
pub fn account_name(entry: &str) -> String {
    format!("{ACCOUNT_PREFIX}{entry}")
}

/// A fresh random 16-byte hex entry id for a new enrolment.
fn new_entry_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| Error::new(ErrorKind::Internal, format!("RNG failure: {e}")))?;
    Ok(hex_encode(&bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Where a keyring account's secret lives: get, set or delete a single named
/// account. Implemented for the real OS keyring ([`KeyringStore`]) and, for
/// tests, an in-memory [`FakeStore`] that can hold many accounts at once —
/// simulating "the same OS keyring" across several enrolments, the same way
/// a real keyring would.
pub trait SecretStore: Send + Sync {
    /// The secret at `account`, or `Ok(None)` if there is none. Never creates one.
    fn get(&self, account: &str) -> Result<Option<String>, Error>;
    fn set(&self, account: &str, value: &str) -> Result<(), Error>;
    /// A no-op (not an error) if nothing is stored at `account`.
    fn delete(&self, account: &str) -> Result<(), Error>;
}

/// The real freedesktop Secret Service / macOS Keychain / Windows Credential
/// Manager entry, via the `keyring` crate.
///
/// Every call first probes (Linux only, [`probe_session_bus`]) whether
/// anything is even there, with a short deadline, then runs the real
/// operation with a long one — see the module docs and
/// [`AVAILABILITY_TIMEOUT`]/[`KEYRING_TIMEOUT`].
pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, Error> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|e| Error::new(ErrorKind::KeyringUnavailable, format!("Couldn't open the keyring entry: {e}")))
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

/// The outcome of a single timed keyring call: success, "no such entry"
/// (kept apart from a real failure so callers can turn it into `Ok(None)`
/// or a no-op), or a classified failure.
enum Outcome<T> {
    Ok(T),
    Missing,
    Failed(Error),
}

/// Runs `f` (a blocking `keyring` call) on its own thread and waits up to
/// `timeout`. A thread that never returns (a prompt nobody answers) is
/// simply abandoned when the channel is dropped; the caller sees a timeout
/// either way.
fn call_keyring<T, F>(f: F, timeout: Duration) -> Outcome<T>
where
    T: Send + 'static,
    F: FnOnce() -> keyring::Result<T> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(value)) => Outcome::Ok(value),
        Ok(Err(keyring::Error::NoEntry)) => Outcome::Missing,
        Ok(Err(e)) => Outcome::Failed(classify(e)),
        Err(_) => Outcome::Failed(Error::new(ErrorKind::KeyringUnavailable, format!("The keyring didn't respond within {}s.", timeout.as_secs()))),
    }
}

/// Maps a `keyring` crate error (anything but `NoEntry`, handled separately)
/// onto our error kinds. See `keyring::secret_service::decode_error`: the
/// crate itself already folds "locked", "no result" and "prompt dismissed"
/// into `NoStorageAccess`, and a dead/missing Secret Service bus connection
/// into `PlatformFailure`. `NoEntry` never reaches here, so "locked" and
/// "missing" can never be confused with one another.
fn classify(e: keyring::Error) -> Error {
    match e {
        keyring::Error::NoStorageAccess(inner) => {
            Error::new(ErrorKind::KeyringLocked, format!("The keyring is locked or refused access: {inner}"))
        }
        keyring::Error::PlatformFailure(inner) => {
            Error::new(ErrorKind::KeyringUnavailable, format!("No keyring service is available: {inner}"))
        }
        keyring::Error::BadEncoding(_) => {
            Error::new(ErrorKind::KeyringCorrupt, "The keyring entry isn't valid UTF-8.".to_owned())
        }
        keyring::Error::NoEntry => unreachable!("NoEntry is handled by call_keyring before classify runs"),
        other => Error::new(ErrorKind::Internal, other.to_string()),
    }
}

/// Fast "is anything there at all" check: is `org.freedesktop.secrets` owned
/// on the session bus? Run before every real call so a desktop with no
/// Secret Service at all fails in about [`AVAILABILITY_TIMEOUT`], not the
/// long [`KEYRING_TIMEOUT`] a real get/set/delete gets (a *locked* wallet
/// legitimately takes a while to answer its own prompt; an absent one never
/// will). Linux only — macOS Keychain and Windows Credential Manager have no
/// equivalent "is the service running" question to ask first.
#[cfg(target_os = "linux")]
fn probe_session_bus() -> Result<(), Error> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome: zbus::Result<bool> = (|| {
            let conn = zbus::blocking::Connection::session()?;
            let dbus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
            let name = zbus::names::BusName::try_from("org.freedesktop.secrets").expect("a valid well-known bus name");
            Ok(dbus.name_has_owner(name)?)
        })();
        let _ = tx.send(outcome);
    });
    match rx.recv_timeout(AVAILABILITY_TIMEOUT) {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(Error::new(ErrorKind::KeyringUnavailable, "No Secret Service is registered on the session bus.")),
        Ok(Err(e)) => Err(Error::new(ErrorKind::KeyringUnavailable, format!("Couldn't reach the session bus: {e}"))),
        Err(_) => Err(Error::new(ErrorKind::KeyringUnavailable, "The session bus didn't answer within 2 seconds.")),
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_session_bus() -> Result<(), Error> {
    Ok(())
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, Error> {
        probe_session_bus()?;
        let entry = self.entry(account)?;
        match call_keyring(move || entry.get_password(), KEYRING_TIMEOUT) {
            Outcome::Ok(value) => Ok(Some(value)),
            Outcome::Missing => Ok(None),
            Outcome::Failed(e) => Err(e),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), Error> {
        probe_session_bus()?;
        let entry = self.entry(account)?;
        let value = value.to_owned();
        match call_keyring(move || entry.set_password(&value), KEYRING_TIMEOUT) {
            Outcome::Ok(()) | Outcome::Missing => Ok(()),
            Outcome::Failed(e) => Err(e),
        }
    }

    fn delete(&self, account: &str) -> Result<(), Error> {
        probe_session_bus()?;
        let entry = self.entry(account)?;
        match call_keyring(move || entry.delete_credential(), KEYRING_TIMEOUT) {
            Outcome::Ok(()) | Outcome::Missing => Ok(()),
            Outcome::Failed(e) => Err(e),
        }
    }
}

/// An in-memory `SecretStore` for tests: no real keyring is ever touched.
/// Holds many accounts at once, simulating a real OS keyring rather than a
/// single fixed slot.
#[derive(Default)]
pub struct FakeStore {
    values: Mutex<std::collections::HashMap<String, String>>,
    /// If set, every call fails with this instead of touching `values`
    /// (simulates a locked/unavailable/corrupt keyring).
    fail: Mutex<Option<ErrorKind>>,
}

impl FakeStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes every subsequent call fail with `kind` instead of succeeding.
    pub fn fail_with(&self, kind: ErrorKind) {
        *self.fail.lock().expect("fake store lock") = Some(kind);
    }

    /// How many accounts currently hold a secret — tests use this to confirm
    /// a superseded or erased entry was actually removed, not just
    /// unreferenced.
    pub fn account_count(&self) -> usize {
        self.values.lock().expect("fake store lock").len()
    }

    fn check_fail(&self) -> Result<(), Error> {
        match *self.fail.lock().expect("fake store lock") {
            Some(kind) => Err(Error::new(kind, "simulated keyring failure")),
            None => Ok(()),
        }
    }
}

impl SecretStore for FakeStore {
    fn get(&self, account: &str) -> Result<Option<String>, Error> {
        self.check_fail()?;
        Ok(self.values.lock().expect("fake store lock").get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), Error> {
        self.check_fail()?;
        self.values.lock().expect("fake store lock").insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), Error> {
        self.check_fail()?;
        self.values.lock().expect("fake store lock").remove(account);
        Ok(())
    }
}

/// Lets a `SecretStore` be shared by multiple owners — e.g. tests that need
/// two `storage::StorageService`s to see the same fake keyring, simulating
/// "the same OS keyring, a different process".
impl<T: SecretStore + ?Sized> SecretStore for std::sync::Arc<T> {
    fn get(&self, account: &str) -> Result<Option<String>, Error> {
        self.as_ref().get(account)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), Error> {
        self.as_ref().set(account, value)
    }

    fn delete(&self, account: &str) -> Result<(), Error> {
        self.as_ref().delete(account)
    }
}

fn encode_key(key: &Key32) -> String {
    STANDARD.encode(key.as_bytes())
}

fn decode_key(encoded: &str) -> Result<Key32, Error> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| Error::new(ErrorKind::KeyringCorrupt, "The keyring secret isn't valid base64."))?;
    Key32::from_slice(&bytes).ok_or_else(|| Error::new(ErrorKind::KeyringCorrupt, "The keyring secret isn't 32 bytes."))
}

/// The keyring slot itself: a 32-byte secret, base64-encoded, under
/// [`SERVICE`] in whatever `SecretStore` is handed to it — one account per
/// enrolment (`account_name`), never a single fixed one.
pub struct KeyringSlot<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> KeyringSlot<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The stored key for `entry`, or `None` if that account is empty.
    pub fn get(&self, entry: &str) -> Result<Option<Key32>, Error> {
        match self.store.get(&account_name(entry))? {
            Some(encoded) => decode_key(&encoded).map(Some),
            None => Ok(None),
        }
    }

    /// Generates a fresh entry id and a fresh random key, and stores it
    /// under that brand-new account. Every call gets its own account, so
    /// there's nothing to overwrite and nothing to guard against — unlike
    /// the old single-fixed-slot design, a stray second call (e.g. a
    /// zombie write from a call whose caller already timed out) can only
    /// ever land on an account nothing references yet.
    pub fn create_new(&self) -> Result<(String, Key32), Error> {
        let entry = new_entry_id()?;
        let key = Key32::random();
        self.store.set(&account_name(&entry), &encode_key(&key))?;
        Ok((entry, key))
    }

    /// Best-effort: deletes the account for `entry`. A no-op if it's already
    /// gone.
    pub fn delete(&self, entry: &str) -> Result<(), Error> {
        self.store.delete(&account_name(entry))
    }
}

/// Which native credential store this platform uses, for display
/// (`storage_keyring_status`'s `backend` field).
pub fn backend_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos-keychain"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "secret-service"
    }
}

/// `storage_keyring_status`'s reply: never the key bytes themselves, only
/// whether a keyring answered and whether it already holds a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringStatus {
    pub available: bool,
    /// Always `false`: every enrolment now has its own account
    /// (`account_name`), so there's no single fixed secret to check before
    /// any `keys.json` exists. Kept for API stability; the UI doesn't act on
    /// it today.
    pub has_secret: bool,
    pub backend: &'static str,
}

/// Probes `store` for the status the Settings/unlock UI shows: whether the
/// keyring answered at all. A locked keyring still counts as "available"
/// (the service exists; it just isn't readable right now) — only an
/// actually unreachable keyring, or a genuinely corrupt entry, reports
/// `available: false`. Uses a fixed, never-written probe account, since
/// there's no per-enrolment entry to check yet at this point.
pub fn status<S: SecretStore>(store: &S) -> KeyringStatus {
    match store.get(STATUS_PROBE_ACCOUNT) {
        Ok(_) => KeyringStatus { available: true, has_secret: false, backend: backend_name() },
        Err(e) if e.kind == ErrorKind::KeyringLocked => {
            KeyringStatus { available: true, has_secret: false, backend: backend_name() }
        }
        Err(_) => KeyringStatus { available: false, has_secret: false, backend: backend_name() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_name_has_the_keyslot_prefix() {
        assert_eq!(account_name("abc123"), "keyslot-abc123");
    }

    #[test]
    fn get_is_none_for_an_unknown_entry_and_some_once_created() {
        let slot = KeyringSlot::new(FakeStore::new());
        assert!(slot.get("never-created").unwrap().is_none());
        let (entry, _key) = slot.create_new().unwrap();
        assert!(slot.get(&entry).unwrap().is_some());
    }

    #[test]
    fn each_create_new_gets_a_distinct_entry_and_secret() {
        let slot = KeyringSlot::new(FakeStore::new());
        let (entry1, key1) = slot.create_new().unwrap();
        let (entry2, key2) = slot.create_new().unwrap();
        assert_ne!(entry1, entry2);
        assert_ne!(key1.as_bytes(), key2.as_bytes());
        // Both accounts coexist; the first is simply orphaned, never
        // overwritten (docs/ENCRYPTION.md: "orphaned leftovers are harmless").
        assert!(slot.get(&entry1).unwrap().is_some());
        assert!(slot.get(&entry2).unwrap().is_some());
    }

    #[test]
    fn delete_removes_it_and_is_a_no_op_when_already_empty() {
        let slot = KeyringSlot::new(FakeStore::new());
        let (entry, _) = slot.create_new().unwrap();
        slot.delete(&entry).unwrap();
        assert!(slot.get(&entry).unwrap().is_none());
        slot.delete(&entry).unwrap(); // no entry to delete: still Ok
    }

    #[test]
    fn get_reports_a_corrupt_entry_distinctly() {
        let store = FakeStore::new();
        store.set(&account_name("x"), "not valid base64 !!").unwrap();
        let slot = KeyringSlot::new(store);
        assert_eq!(slot.get("x").unwrap_err().kind, ErrorKind::KeyringCorrupt);
    }

    #[test]
    fn get_reports_the_wrong_length_as_corrupt_too() {
        let store = FakeStore::new();
        store.set(&account_name("x"), &STANDARD.encode(b"too short")).unwrap();
        let slot = KeyringSlot::new(store);
        assert_eq!(slot.get("x").unwrap_err().kind, ErrorKind::KeyringCorrupt);
    }

    #[test]
    fn propagates_locked_and_unavailable_errors_distinctly() {
        for kind in [ErrorKind::KeyringLocked, ErrorKind::KeyringUnavailable] {
            let store = FakeStore::new();
            store.fail_with(kind);
            let slot = KeyringSlot::new(store);
            assert_eq!(slot.get("x").unwrap_err().kind, kind);
            assert_eq!(slot.create_new().unwrap_err().kind, kind);
        }
    }

    #[test]
    fn backend_name_is_one_of_the_known_platforms() {
        assert!(["secret-service", "macos-keychain", "windows"].contains(&backend_name()));
    }

    #[test]
    fn status_reports_available_and_never_a_secret_pre_setup() {
        let store = FakeStore::new();
        let before = status(&store);
        assert!(before.available);
        assert!(!before.has_secret);
        // A real secret always lives under its own per-enrolment account,
        // never the fixed status-probe one, so `has_secret` stays false even
        // once other entries exist.
        store.set(&account_name("some-entry"), "anything").unwrap();
        assert!(!status(&store).has_secret);
    }

    #[test]
    fn status_treats_a_locked_keyring_as_available_with_no_known_secret() {
        let store = FakeStore::new();
        store.fail_with(ErrorKind::KeyringLocked);
        let s = status(&store);
        assert!(s.available);
        assert!(!s.has_secret);
    }

    #[test]
    fn status_reports_an_unreachable_keyring_as_unavailable() {
        let store = FakeStore::new();
        store.fail_with(ErrorKind::KeyringUnavailable);
        let s = status(&store);
        assert!(!s.available);
        assert!(!s.has_secret);
    }

    #[test]
    fn the_long_timeout_is_longer_than_the_availability_probe() {
        assert!(KEYRING_TIMEOUT > AVAILABILITY_TIMEOUT);
    }
}
