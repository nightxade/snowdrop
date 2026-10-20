//! Glue between the signal-cli vault (`vault::VaultSession`) and the
//! signal-cli process lifecycle (`service::Service`): where to spawn
//! signal-cli's `--config` dir, when to sync, how a `getAttachment` request
//! hydrates media on demand, and the stop-then-sync shutdown and
//! discard-on-erase orderings (docs/ENCRYPTION.md, "signal-cli vault").
//!
//! Kept separate from `service.rs` and `storage.rs` so neither has to know
//! the other's shape: this module reaches `storage::StorageService` only
//! through two small closures the caller provides ([`IsUnlocked`],
//! [`TakeSessionParts`]), so it never depends on `StorageService`'s
//! `SecretStore` type parameter, and is testable with closures over plain
//! fixtures instead of a real keyring (see this module's tests).
//!
//! One [`VaultBridge`] lives for the app's lifetime. It owns at most one
//! [`VaultSession`] — `storage::StorageService::vault_session_parts` only
//! ever hands over its instance lock once, so this is the one place in the
//! app allowed to call it (task 4b's contract with task 4). Reconnects and
//! respawns reuse whatever session was already built.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{interval, sleep, MissedTickBehavior};

use crate::error::{Error, ErrorKind};
use crate::storage::VaultSessionParts;
use crate::vault::{VaultSession, DEFAULT_MEDIA_BUDGET_BYTES, DEFAULT_MEDIA_IDLE};

/// Cheap, non-mutating check of whether storage is `Unlocked` right now
/// (in practice `StorageService::webcache_key().is_some()`), used before
/// trying to build a session so a `connect` while `Locked`/`NeedsSetup`
/// fails fast with [`ErrorKind::StorageLocked`] instead of some confusing
/// lock or I/O error further down.
pub type IsUnlocked = Box<dyn Fn() -> bool + Send + Sync>;

/// Takes the vault/runtime-dir/lock triple exactly once (in practice
/// `StorageService::vault_session_parts`); `None` after the first success,
/// or whenever storage isn't `Unlocked`.
pub type TakeSessionParts = Box<dyn Fn() -> Option<VaultSessionParts> + Send + Sync>;

/// How long a sync debounces after the last trigger (docs/ENCRYPTION.md,
/// "When to sync").
const DEBOUNCE: Duration = Duration::from_secs(2);
/// The periodic fallback while dirty — covers a sync that failed and is
/// waiting to be retried, or a trigger that never got a quiet moment.
const PERIODIC: Duration = Duration::from_secs(60);
/// Longest [`VaultBridge::shutdown`] waits for the final sync before giving
/// up on it (docs/ENCRYPTION.md: "Keep exit bounded").
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(10);

/// The methods a successful `signal_cli_request` should mark the vault dirty
/// for (docs/ENCRYPTION.md, "When to sync"): any `send*`, plus
/// `updateGroup`/`updateContact`/`finishLink`.
pub fn triggers_sync(method: &str) -> bool {
    method.starts_with("send") || matches!(method, "updateGroup" | "updateContact" | "finishLink")
}

/// Maps a `getAttachment` request's `id` param to the manifest relpath
/// signal-cli itself would use (`AttachmentStore.sanitizeId` in
/// AsamK/signal-cli: every character outside `[A-Za-z0-9_.-]` becomes `_`).
/// This can't escape `attachments/`: the result never contains a `/`, so no
/// path component of it can ever be `..`. [`VaultSession::ensure_media`]
/// still runs its own `validate_relpath` underneath, as defense in depth.
fn attachment_relpath(id: &str) -> String {
    let safe: String =
        id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '_' }).collect();
    format!("attachments/{safe}")
}

struct Inner {
    disabled: bool,
    is_unlocked: IsUnlocked,
    take_session_parts: TakeSessionParts,
    session: Mutex<Option<VaultSession>>,
    /// Set once, by [`VaultBridge::discard`]: no sync may run again, even
    /// one already mid-flight when it finds the session gone.
    erased: AtomicBool,
    /// Incremented every time [`VaultBridge::sync_once`] actually touches a
    /// session (disabled/no-session/erased calls don't count) — test-only
    /// instrumentation for the debouncer's "coalesces a burst" behaviour,
    /// which is otherwise unobservable from outside this module.
    #[cfg(test)]
    sync_attempts: AtomicUsize,
}

pub struct VaultBridge {
    inner: Inner,
    trigger_tx: mpsc::UnboundedSender<()>,
}

impl VaultBridge {
    /// Builds a bridge. The caller drives [`run_sync_loop`] on the returned
    /// receiver — production spawns it once in `lib.rs`'s `setup`; tests
    /// spawn it per test, or skip it entirely for a bridge nothing will ever
    /// mark dirty (e.g. [`VaultBridge::disabled`]).
    pub fn new(disabled: bool, is_unlocked: IsUnlocked, take_session_parts: TakeSessionParts) -> (Arc<Self>, mpsc::UnboundedReceiver<()>) {
        let (trigger_tx, rx) = mpsc::unbounded_channel();
        let bridge = Arc::new(Self {
            inner: Inner {
                disabled,
                is_unlocked,
                take_session_parts,
                session: Mutex::new(None),
                erased: AtomicBool::new(false),
                #[cfg(test)]
                sync_attempts: AtomicUsize::new(0),
            },
            trigger_tx,
        });
        (bridge, rx)
    }

    /// A bridge that never builds a session: `SNOWDROP_SIGNAL_CLI_DATA` or an
    /// external daemon (docs/ENCRYPTION.md, "Not covered") — every method
    /// here is a cheap pass-through/no-op, and no background task is needed.
    pub fn disabled() -> Arc<Self> {
        Self::new(true, Box::new(|| false), Box::new(|| None)).0
    }

    /// The signal-cli `--config` directory for a managed child: the vault's
    /// RAM-backed runtime dir once storage is unlocked and the vault
    /// applies, or `fallback` unchanged when the vault is disabled (today's
    /// behaviour). Only ever builds a session the first time this succeeds,
    /// for the life of the process; every later call (a reconnect, a respawn
    /// after a crash) reuses it.
    pub fn spawn_config_dir(&self, fallback: &Path) -> Result<PathBuf, Error> {
        if self.inner.disabled {
            return Ok(fallback.to_path_buf());
        }
        if let Some(dir) = self.cached_runtime_dir() {
            return Ok(dir);
        }
        if self.inner.erased.load(Ordering::SeqCst) {
            return Err(Error::new(ErrorKind::Internal, "Local storage was erased; restart Snowdrop to connect again."));
        }
        let locked_err = || Error::new(ErrorKind::StorageLocked, "Unlock local storage before connecting.");
        if !(self.inner.is_unlocked)() {
            return Err(locked_err());
        }
        let (vault, runtime_dir, lock) = (self.inner.take_session_parts)().ok_or_else(locked_err)?;
        let session = VaultSession::start(vault, runtime_dir, lock)?;
        let dir = session.runtime_dir().to_path_buf();
        *self.inner.session.lock().expect("vault session lock") = Some(session);
        Ok(dir)
    }

    /// Whether a managed child could be spawned right now without asking the
    /// user for anything: the vault is disabled, or its session is already
    /// built, or storage is unlocked. `false` once erased. Used only to decide
    /// whether to pre-spawn (`Service::prespawn`); it never builds a session.
    pub fn ready_to_spawn(&self) -> bool {
        if self.inner.disabled {
            return true;
        }
        if self.inner.erased.load(Ordering::SeqCst) {
            return false;
        }
        self.cached_runtime_dir().is_some() || (self.inner.is_unlocked)()
    }

    fn cached_runtime_dir(&self) -> Option<PathBuf> {
        self.inner.session.lock().expect("vault session lock").as_ref().map(|s| s.runtime_dir().to_path_buf())
    }

    /// Marks the vault dirty: [`run_sync_loop`] syncs within [`DEBOUNCE`] of
    /// the last trigger, or sooner if it's already mid-debounce. Cheap and
    /// safe to call even when disabled or no session exists yet — there's
    /// simply nothing for the loop to do once it wakes.
    pub fn trigger(&self) {
        let _ = self.trigger_tx.send(());
    }

    /// Hydrates `attachments/<sanitized id>` into the runtime dir before a
    /// `getAttachment` request reaches signal-cli (docs/ENCRYPTION.md,
    /// "Attachment budget"). A no-op when disabled or no session has been
    /// built yet — signal-cli then reports the file missing itself, same as
    /// it would with no vault at all.
    pub fn ensure_attachment(&self, id: &str) -> Result<(), Error> {
        if self.inner.disabled {
            return Ok(());
        }
        let relpath = attachment_relpath(id);
        let mut guard = self.inner.session.lock().expect("vault session lock");
        let Some(session) = guard.as_mut() else { return Ok(()) };
        session.ensure_media(&relpath)?;
        Ok(())
    }

    /// One sync-then-evict pass. `true`: clean (including "nothing to do").
    /// `false`: the sync itself failed and should be retried on the next
    /// trigger — logged with no secret material, same as every other
    /// `Error` in this codebase.
    fn sync_once(&self) -> bool {
        if self.inner.disabled || self.inner.erased.load(Ordering::SeqCst) {
            return true;
        }
        let mut guard = self.inner.session.lock().expect("vault session lock");
        let Some(session) = guard.as_mut() else { return true };
        #[cfg(test)]
        self.inner.sync_attempts.fetch_add(1, Ordering::SeqCst);
        if let Err(e) = session.sync() {
            log::warn!("vault: sync failed, will retry on the next trigger: {e}");
            return false;
        }
        if let Err(e) = session.evict_media(DEFAULT_MEDIA_BUDGET_BYTES, DEFAULT_MEDIA_IDLE) {
            // Eviction failing doesn't mean the sync did; never worth
            // retrying the sync itself over this.
            log::warn!("vault: eviction after a sync didn't complete: {e}");
        }
        true
    }

    /// The vault half of shutdown; the signal-cli-process half
    /// (`service::Service::stop_backend`) must already have completed by
    /// the time this is called, so the final sync never races a still-live
    /// signal-cli writing to the same files. Bounded to about
    /// [`SHUTDOWN_BUDGET`]: past that, the runtime dir is left exactly as it
    /// is, for the next launch's crash recovery (docs/ENCRYPTION.md).
    pub async fn shutdown(&self) {
        let Some(session) = self.inner.session.lock().expect("vault session lock").take() else { return };
        let result = tokio::time::timeout(SHUTDOWN_BUDGET, tokio::task::spawn_blocking(move || session.shutdown())).await;
        match result {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => log::warn!("vault: the final sync on shutdown failed ({e}); the runtime dir is left for crash recovery."),
            Ok(Err(_)) => log::warn!("vault: the shutdown task panicked."),
            Err(_) => log::warn!("vault: the final sync didn't finish within {SHUTDOWN_BUDGET:?}; leaving the runtime dir for crash recovery."),
        }
    }

    /// `storage::StorageService`'s erase hook (docs/ENCRYPTION.md, "Erase"):
    /// discards the session *without* syncing it first — erasing can't be
    /// allowed to re-create what it just deleted — and wipes the runtime dir
    /// directly. Marks the bridge erased for good: `storage_erase_all`
    /// already consumed the one instance lock this process will ever get
    /// (see [`spawn_config_dir`](Self::spawn_config_dir)), so no vault can be
    /// rebuilt here even after a fresh `storage_setup` in the same run.
    pub fn discard(&self) {
        self.inner.erased.store(true, Ordering::SeqCst);
        let Some(session) = self.inner.session.lock().expect("vault session lock").take() else { return };
        let runtime_dir = session.runtime_dir().to_path_buf();
        drop(session); // dropped, not `shutdown()`'d: no final sync.
        if let Err(e) = std::fs::remove_dir_all(&runtime_dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("vault: couldn't wipe the runtime dir while erasing: {e}");
            }
        }
    }

    #[cfg(test)]
    fn sync_attempts(&self) -> usize {
        self.inner.sync_attempts.load(Ordering::SeqCst)
    }
}

/// Debounces triggers into a sync about [`DEBOUNCE`] after the last one
/// (a burst of triggers settles into one sync), with a [`PERIODIC`] fallback
/// while dirty. Exits once every sender (every [`VaultBridge::trigger`]
/// caller) is gone — in practice, never, for the life of the app.
pub async fn run_sync_loop(bridge: Arc<VaultBridge>, mut trigger_rx: mpsc::UnboundedReceiver<()>) {
    let mut ticker = interval(PERIODIC);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick fires immediately; skip it.
    let mut dirty = false;
    loop {
        tokio::select! {
            signal = trigger_rx.recv() => {
                let Some(()) = signal else { break };
                dirty = true;
                // Let any further trigger within the next `DEBOUNCE` reset
                // the window, so a burst settles into exactly one sync.
                loop {
                    tokio::select! {
                        () = sleep(DEBOUNCE) => break,
                        again = trigger_rx.recv() => match again {
                            Some(()) => dirty = true,
                            None => return,
                        },
                    }
                }
            }
            _ = ticker.tick() => {}
        }
        if dirty {
            let bridge = bridge.clone();
            let clean = tokio::task::spawn_blocking(move || bridge.sync_once()).await.unwrap_or(false);
            dirty = !clean;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;
    use crate::vault::{InstanceLock, Vault, VAULT_ID_LEN};
    use std::fs;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-bridge-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    fn write_file(dir: &Path, relpath: &str, contents: &[u8]) {
        let path = dir.join(relpath);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
    }

    /// A vault pre-populated with a non-media file and an attachment, plus
    /// the `(Vault, PathBuf, InstanceLock)` triple a real
    /// `StorageService::vault_session_parts()` would hand over — built
    /// straight from `Vault`/`InstanceLock`, so these tests never need a
    /// real `StorageService` or keyring. The `TempDir` guard is returned
    /// alongside the parts: it must outlive every use of the paths inside
    /// them (in particular the runtime dir a `VaultSession` restores into),
    /// so callers keep it bound for the rest of the test rather than letting
    /// it drop here.
    fn fixture(name: &str) -> (TempDir, VaultSessionParts) {
        let base = temp_dir(name);
        let seed = base.path().join("seed");
        write_file(&seed, "data/account", b"account data");
        write_file(&seed, "attachments/photo.jpg", b"fake jpeg bytes");
        let vault = Vault::open(&base.path().join("vault"), Key32::random(), [1u8; VAULT_ID_LEN]).unwrap();
        vault.sync(&seed).unwrap();
        let runtime_dir = base.path().join("runtime");
        let lock = InstanceLock::acquire(&base.path().join("app-data")).unwrap();
        (base, (vault, runtime_dir, lock))
    }

    fn always_unlocked() -> IsUnlocked {
        Box::new(|| true)
    }

    fn always_locked() -> IsUnlocked {
        Box::new(|| false)
    }

    /// Hands `parts` out exactly once, like the real
    /// `StorageService::vault_session_parts` — and passes the fixture's
    /// `TempDir` guard through unchanged, for the caller to keep alive.
    fn once(fixture: (TempDir, VaultSessionParts)) -> (TempDir, TakeSessionParts) {
        let (guard, parts) = fixture;
        let slot = Mutex::new(Some(parts));
        (guard, Box::new(move || slot.lock().expect("fixture lock").take()))
    }

    #[test]
    fn attachment_id_is_sanitized_like_signal_clis_own_store() {
        assert_eq!(attachment_relpath("abc123.jpg"), "attachments/abc123.jpg");
        assert_eq!(attachment_relpath("weird id!@#"), "attachments/weird_id___");
    }

    #[test]
    fn disabled_bridge_keeps_the_fallback_dir_and_is_a_no_op_everywhere() {
        let bridge = VaultBridge::disabled();
        let fallback = PathBuf::from("/data/signal-cli");
        assert_eq!(bridge.spawn_config_dir(&fallback).unwrap(), fallback);
        bridge.ensure_attachment("anything").unwrap();
        bridge.trigger(); // must not panic or hang with no loop driving it
        // sync_once's early return for "disabled" is itself a success case
        // (nothing to retry), not a failure one:
        assert!(bridge.sync_once());
    }

    #[test]
    fn locked_storage_fails_fast_without_touching_session_parts() {
        let (bridge, _rx) = VaultBridge::new(false, always_locked(), Box::new(|| panic!("must not be called while locked")));
        let err = bridge.spawn_config_dir(Path::new("/fallback")).unwrap_err();
        assert_eq!(err.kind, ErrorKind::StorageLocked);
    }

    #[test]
    fn spawn_dir_restores_non_media_excludes_media_and_is_reused() {
        let (_guard, take_parts) = once(fixture("restore"));
        let (bridge, _rx) = VaultBridge::new(false, always_unlocked(), take_parts);
        let fallback = PathBuf::from("/should-not-be-used");
        let dir = bridge.spawn_config_dir(&fallback).unwrap();
        assert!(dir.join("data/account").exists());
        assert!(!dir.join("attachments/photo.jpg").exists(), "media must not be restored up front");

        bridge.ensure_attachment("photo.jpg").unwrap();
        assert_eq!(fs::read(dir.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");

        // A reconnect reuses the same session/dir rather than erroring (the
        // one-shot `take_session_parts` was already spent above).
        assert_eq!(bridge.spawn_config_dir(&fallback).unwrap(), dir);
    }

    #[test]
    fn ensure_attachment_rejects_a_traversal_id() {
        let (_guard, take_parts) = once(fixture("traversal"));
        let (bridge, _rx) = VaultBridge::new(false, always_unlocked(), take_parts);
        bridge.spawn_config_dir(Path::new("/fallback")).unwrap();
        // ".." has no characters `attachment_relpath` replaces, so it must be
        // `ensure_media`'s own `validate_relpath` that catches it.
        let err = bridge.ensure_attachment("..").unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn debounce_coalesces_a_burst_of_triggers_into_one_sync() {
        let (_guard, take_parts) = once(fixture("debounce"));
        let (bridge, rx) = VaultBridge::new(false, always_unlocked(), take_parts);
        bridge.spawn_config_dir(Path::new("/fallback")).unwrap();
        let handle = tokio::spawn(run_sync_loop(bridge.clone(), rx));

        for _ in 0..5 {
            bridge.trigger();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // The debounce window (2s) plus slack for the sync itself.
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(bridge.sync_attempts(), 1, "a burst of triggers must settle into exactly one sync");

        bridge.trigger();
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(bridge.sync_attempts(), 2, "a later, separate trigger gets its own sync");

        handle.abort();
    }

    #[tokio::test]
    async fn shutdown_does_a_final_sync_then_wipes_the_runtime_dir() {
        let (_guard, take_parts) = once(fixture("shutdown"));
        let (bridge, _rx) = VaultBridge::new(false, always_unlocked(), take_parts);
        let dir = bridge.spawn_config_dir(Path::new("/fallback")).unwrap();
        fs::write(dir.join("data/account"), b"changed just before shutdown").unwrap();

        bridge.shutdown().await;
        assert!(!dir.exists(), "the runtime dir must be wiped after a clean shutdown");
    }

    #[tokio::test]
    async fn discard_wipes_without_syncing_and_cant_rebuild() {
        let (_guard, take_parts) = once(fixture("erase"));
        let (bridge, _rx) = VaultBridge::new(false, always_unlocked(), take_parts);
        let dir = bridge.spawn_config_dir(Path::new("/fallback")).unwrap();
        fs::write(dir.join("data/account"), b"unsynced change, must be discarded").unwrap();

        bridge.discard();
        assert!(!dir.exists(), "the runtime dir must be wiped");
        assert_eq!(bridge.sync_attempts(), 0, "discard must never sync");

        // Once erased, the bridge refuses to rebuild a session even though
        // storage reports unlocked — there's no instance lock left to give it.
        let err = bridge.spawn_config_dir(Path::new("/fallback")).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Internal);
        // sync_once treats "erased" the same as "nothing to do": a clean
        // `true`, never a failure to retry.
        assert!(bridge.sync_once());
    }
}
