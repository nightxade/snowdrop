//! The keyring slot: a random 32-byte secret stored in the platform's
//! credential store, which wraps the vault's DEK (docs/ENCRYPTION.md, "Key
//! hierarchy"). `SecretStore` is the seam between that logic and the actual
//! OS keyring, so `KeyringSlot` is tested against an in-memory fake and a
//! real keyring is never touched in tests.

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
pub const ACCOUNT: &str = "keyslot-v1";

const KEYRING_TIMEOUT: Duration = Duration::from_secs(5);

/// Where the keyring slot's secret lives: get, set or delete a single named
/// value. Implemented for the real OS keyring ([`KeyringStore`]) and, for
/// tests, an in-memory [`FakeStore`].
pub trait SecretStore: Send + Sync {
    /// The stored secret, or `Ok(None)` if there is none. Never creates one.
    fn get(&self) -> Result<Option<String>, Error>;
    fn set(&self, value: &str) -> Result<(), Error>;
    /// A no-op (not an error) if nothing is stored.
    fn delete(&self) -> Result<(), Error>;
}

/// The real freedesktop Secret Service / macOS Keychain / Windows Credential
/// Manager entry, via the `keyring` crate.
///
/// Every call runs on its own thread with a ~5s deadline: a keyring with no
/// backend (e.g. a bare Hyprland session with no Secret Service on the bus)
/// or one that never answers a prompt must never hang the caller.
pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self) -> Result<keyring::Entry, Error> {
        keyring::Entry::new(SERVICE, ACCOUNT)
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
/// [`KEYRING_TIMEOUT`]. A thread that never returns (a prompt nobody answers)
/// is simply abandoned when the channel is dropped; the caller sees a timeout
/// either way.
fn call_keyring<T, F>(f: F) -> Outcome<T>
where
    T: Send + 'static,
    F: FnOnce() -> keyring::Result<T> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(KEYRING_TIMEOUT) {
        Ok(Ok(value)) => Outcome::Ok(value),
        Ok(Err(keyring::Error::NoEntry)) => Outcome::Missing,
        Ok(Err(e)) => Outcome::Failed(classify(e)),
        Err(_) => Outcome::Failed(Error::new(ErrorKind::KeyringUnavailable, "The keyring didn't respond within 5 seconds.")),
    }
}

/// Maps a `keyring` crate error (anything but `NoEntry`, handled separately)
/// onto our error kinds. See `keyring::secret_service::decode_error`: the
/// crate itself already folds "locked", "no result" and "prompt dismissed"
/// into `NoStorageAccess`, and a dead/missing Secret Service bus connection
/// into `PlatformFailure`.
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

impl SecretStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, Error> {
        let entry = self.entry()?;
        match call_keyring(move || entry.get_password()) {
            Outcome::Ok(value) => Ok(Some(value)),
            Outcome::Missing => Ok(None),
            Outcome::Failed(e) => Err(e),
        }
    }

    fn set(&self, value: &str) -> Result<(), Error> {
        let entry = self.entry()?;
        let value = value.to_owned();
        match call_keyring(move || entry.set_password(&value)) {
            Outcome::Ok(()) | Outcome::Missing => Ok(()),
            Outcome::Failed(e) => Err(e),
        }
    }

    fn delete(&self) -> Result<(), Error> {
        let entry = self.entry()?;
        match call_keyring(move || entry.delete_credential()) {
            Outcome::Ok(()) | Outcome::Missing => Ok(()),
            Outcome::Failed(e) => Err(e),
        }
    }
}

/// An in-memory `SecretStore` for tests: no real keyring is ever touched.
#[derive(Default)]
pub struct FakeStore {
    value: Mutex<Option<String>>,
    /// If set, every call fails with this instead of touching `value`
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

    fn check_fail(&self) -> Result<(), Error> {
        match *self.fail.lock().expect("fake store lock") {
            Some(kind) => Err(Error::new(kind, "simulated keyring failure")),
            None => Ok(()),
        }
    }
}

impl SecretStore for FakeStore {
    fn get(&self) -> Result<Option<String>, Error> {
        self.check_fail()?;
        Ok(self.value.lock().expect("fake store lock").clone())
    }

    fn set(&self, value: &str) -> Result<(), Error> {
        self.check_fail()?;
        *self.value.lock().expect("fake store lock") = Some(value.to_owned());
        Ok(())
    }

    fn delete(&self) -> Result<(), Error> {
        self.check_fail()?;
        *self.value.lock().expect("fake store lock") = None;
        Ok(())
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
/// [`SERVICE`]/[`ACCOUNT`] in whatever `SecretStore` is handed to it.
pub struct KeyringSlot<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> KeyringSlot<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The stored key, or `None` if the slot is empty. Never creates one —
    /// use [`create_new`](Self::create_new) for that.
    pub fn get(&self) -> Result<Option<Key32>, Error> {
        match self.store.get()? {
            Some(encoded) => decode_key(&encoded).map(Some),
            None => Ok(None),
        }
    }

    /// Generates a fresh random key and stores it, but only if the slot is
    /// currently empty — so a stray second call never silently overwrites
    /// (and thereby orphans whatever this slot already unwraps). Use
    /// [`replace`](Self::replace) to overwrite deliberately.
    pub fn create_new(&self) -> Result<Key32, Error> {
        if self.store.get()?.is_some() {
            return Err(Error::new(
                ErrorKind::Config,
                "A keyring secret already exists; use replace to overwrite it deliberately.",
            ));
        }
        self.store_new()
    }

    /// Unconditionally overwrites whatever is stored with a fresh random key
    /// (switching keyring providers; see docs/ENCRYPTION.md).
    pub fn replace(&self) -> Result<Key32, Error> {
        self.store_new()
    }

    fn store_new(&self) -> Result<Key32, Error> {
        let key = Key32::random();
        self.store.set(&encode_key(&key))?;
        Ok(key)
    }

    pub fn delete(&self) -> Result<(), Error> {
        self.store.delete()
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
    pub has_secret: bool,
    pub backend: &'static str,
}

/// Probes `store` for the status the Settings/unlock UI shows: whether the
/// keyring answered at all, and whether it already has a secret. A locked
/// keyring still counts as "available" (the service exists; it just isn't
/// readable right now) — only an actually unreachable keyring, or a
/// genuinely corrupt entry, reports `available: false`.
pub fn status<S: SecretStore>(store: &S) -> KeyringStatus {
    match store.get() {
        Ok(secret) => KeyringStatus { available: true, has_secret: secret.is_some(), backend: backend_name() },
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
    fn get_is_none_until_something_is_created() {
        let slot = KeyringSlot::new(FakeStore::new());
        assert!(slot.get().unwrap().is_none());
        slot.create_new().unwrap();
        assert!(slot.get().unwrap().is_some());
    }

    #[test]
    fn create_new_never_overwrites_an_existing_secret() {
        let slot = KeyringSlot::new(FakeStore::new());
        let first = slot.create_new().unwrap();
        let err = slot.create_new().unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        // The original key is untouched.
        assert_eq!(slot.get().unwrap().unwrap().as_bytes(), first.as_bytes());
    }

    #[test]
    fn replace_overwrites_deliberately() {
        let slot = KeyringSlot::new(FakeStore::new());
        let first = slot.create_new().unwrap();
        let second = slot.replace().unwrap();
        assert_ne!(first.as_bytes(), second.as_bytes());
        assert_eq!(slot.get().unwrap().unwrap().as_bytes(), second.as_bytes());
    }

    #[test]
    fn delete_removes_it_and_is_a_no_op_when_already_empty() {
        let slot = KeyringSlot::new(FakeStore::new());
        slot.create_new().unwrap();
        slot.delete().unwrap();
        assert!(slot.get().unwrap().is_none());
        slot.delete().unwrap(); // no entry to delete: still Ok
    }

    #[test]
    fn get_reports_a_corrupt_entry_distinctly() {
        let store = FakeStore::new();
        store.set("not valid base64 !!").unwrap();
        let slot = KeyringSlot::new(store);
        assert_eq!(slot.get().unwrap_err().kind, ErrorKind::KeyringCorrupt);
    }

    #[test]
    fn get_reports_the_wrong_length_as_corrupt_too() {
        let store = FakeStore::new();
        store.set(&STANDARD.encode(b"too short")).unwrap();
        let slot = KeyringSlot::new(store);
        assert_eq!(slot.get().unwrap_err().kind, ErrorKind::KeyringCorrupt);
    }

    #[test]
    fn propagates_locked_and_unavailable_errors_distinctly() {
        for kind in [ErrorKind::KeyringLocked, ErrorKind::KeyringUnavailable] {
            let store = FakeStore::new();
            store.fail_with(kind);
            let slot = KeyringSlot::new(store);
            assert_eq!(slot.get().unwrap_err().kind, kind);
            assert_eq!(slot.create_new().unwrap_err().kind, kind);
        }
    }

    #[test]
    fn backend_name_is_one_of_the_known_platforms() {
        assert!(["secret-service", "macos-keychain", "windows"].contains(&backend_name()));
    }

    #[test]
    fn status_reports_available_and_whether_a_secret_exists() {
        let store = FakeStore::new();
        let before = status(&store);
        assert!(before.available);
        assert!(!before.has_secret);
        store.set("anything").unwrap();
        assert!(status(&store).has_secret);
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
}
