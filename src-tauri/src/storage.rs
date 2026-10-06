//! The storage state machine (docs/ENCRYPTION.md, "Implementation plan",
//! step 4): `NeedsSetup → Locked → Unlocked`, plus `Unavailable` when
//! nothing can proceed at all (no RAM dir, or another instance already
//! running). Tauri commands are the thin binding layer in `commands.rs`;
//! this module is plain logic, testable with `secrets::FakeStore` and an
//! injected runtime-dir resolver, same as `keyslots` and `vault`.
//!
//! What this module does *not* do: wire a [`vault::VaultSession`] into the
//! signal-cli process (spawn dir, sync triggers, media) — that's task 4b,
//! via [`StorageService::vault_session_parts`].

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::aead::Key32;
use crate::error::{Error, ErrorKind};
use crate::keyslots::{self, RecoveryCode};
use crate::secrets::{self, KeyringSlot, KeyringStore, SecretStore};
use crate::vault::{InstanceLock, Vault};

/// Resolves the RAM-backed signal-cli runtime dir (`vault::resolve_runtime_dir`
/// in production; a temp-dir closure in tests).
pub type RuntimeDirResolver = Box<dyn Fn() -> Result<PathBuf, Error> + Send + Sync>;

/// A hook run (synchronously), with no lock held on this service, between
/// [`StorageService::begin_erase`]/[`begin_sign_out`](StorageService::begin_sign_out)
/// and their `finish_*` counterparts, before anything is deleted. Task 4b
/// hangs the signal-cli shutdown and vault discard off this, since storage
/// itself knows nothing about the running process. `Arc`, not `Box`: the
/// caller clones the list out of `on_erase` under a brief lock (see
/// [`StorageService::begin_erase`]) and runs it afterwards with that lock
/// released — the whole point being that nothing here can still be holding
/// storage's own lock while a hook reaches back into `Service`, which takes
/// its own lock to stop the backend, while `Service::connect` holds that
/// same lock across a call back into storage (docs/ENCRYPTION.md, "Erase";
/// this is the deadlock `begin_erase`/`finish_erase` avoid).
pub type EraseHook = Arc<dyn Fn() + Send + Sync>;

/// Where `keys.json` and the vault live, plus `snowdrop.log` (deleted,
/// along with its `.1` rotation, by both [`StorageService::erase_all`] and
/// sign-out: an erase or a sign-out that leaves the old log behind would
/// leave this account's history sitting in plaintext next to a vault that's
/// otherwise gone). All under the Tauri app data dir.
#[derive(Debug, Clone)]
pub struct StoragePaths {
    pub app_data_dir: PathBuf,
    pub keys_path: PathBuf,
    pub vault_dir: PathBuf,
    pub log_file: Option<PathBuf>,
    /// Whether `SNOWDROP_SIGNAL_CLI_DATA` pointed signal-cli somewhere
    /// outside Snowdrop's management when the app started (`lib.rs`'s
    /// `data_dir` resolution) — that data is never Snowdrop's to encrypt or
    /// migrate (docs/ENCRYPTION.md, "Not covered"). Read once at startup and
    /// carried in here, the same way `vault::runtime::resolve_with` takes
    /// its environment lookup as a parameter rather than reading it live:
    /// the real value can never change during a run, and a live read would
    /// only invite a race against whatever else in the process touches
    /// process-wide environment state (e.g. two tests running in parallel).
    pub external_override: bool,
}

impl StoragePaths {
    pub fn new(app_data_dir: PathBuf, log_file: Option<PathBuf>, external_override: bool) -> Self {
        Self {
            keys_path: app_data_dir.join("keys.json"),
            vault_dir: app_data_dir.join("vault"),
            app_data_dir,
            log_file,
            external_override,
        }
    }
}

/// An existing plaintext `<app data>/signal-cli/` left by a build that
/// predates the vault (docs/ENCRYPTION.md, "Migration").
fn legacy_signal_cli_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("signal-cli")
}

/// `<app data>/bin/`: where `signal_cli_install.rs` installs a downloaded
/// signal-cli (and stages one mid-download) — removed by
/// [`StorageService::finish_erase`], but never by sign-out: erasing wipes
/// everything Snowdrop manages here, while signing out only ends an account
/// session and must leave the installed binary alone so the next sign-in
/// doesn't have to re-download ~114 MB.
fn bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin")
}

/// Whether `<app data>/signal-cli/` looks like signal-cli's own plaintext
/// *data* dir, left by a build that predates the vault
/// (docs/ENCRYPTION.md, "Migration") — not just any directory happening to
/// exist at that path. signal-cli's own layout is exactly `data/`,
/// `attachments/`, `avatars/`, `stickers/` (`PathConfig.createDefault`
/// upstream), so this requires a `data/` *subdirectory* specifically.
///
/// This distinction used to matter a lot: before `signal_cli_install.rs`
/// moved its installs under `<app data>/bin/`, a downloaded-but-never-yet-
/// run signal-cli binary lived at this exact same path
/// (`<app data>/signal-cli/<version>/signal-cli`) and had no `data/`
/// subdirectory at all — but the old, cruder check (any directory at all)
/// still treated it as legacy data, synced the ~370 MB binary into the
/// vault, garbage-collected the real account data's blobs out from under
/// it, and then deleted the "legacy dir" — taking the binary with it.
fn is_legacy_signal_cli_dir(app_data_dir: &Path) -> bool {
    legacy_signal_cli_dir(app_data_dir).join("data").is_dir()
}

/// Why storage is [`StorageState::Locked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockedReason {
    /// No keyring service answered at all.
    KeyringUnavailable,
    /// The keyring is reachable but locked or refused access.
    KeyringLocked,
    /// The file has a keyring slot, but the OS keyring has no secret (or one
    /// that doesn't unwrap it) for it — corrupt and auth-failed collapse
    /// into this too; the unlock screen's remedy is the same either way: a
    /// recovery code, a passphrase, or re-enrolling once unlocked.
    KeyringSecretMissing,
    /// No keyring slot at all: passphrase mode, or recovery-only. The user
    /// must type something manually every launch.
    PassphraseRequired,
}

impl LockedReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::KeyringUnavailable => "keyringUnavailable",
            Self::KeyringLocked => "keyringLocked",
            Self::KeyringSecretMissing => "keyringSecretMissing",
            Self::PassphraseRequired => "passphraseRequired",
        }
    }
}

/// Why storage is [`StorageState::Unavailable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    /// No RAM-backed directory is available for the signal-cli runtime dir.
    NoRamDir,
    /// `snowdrop.lock` is already held by another instance.
    AlreadyRunning,
}

impl UnavailableReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::NoRamDir => "noRamDir",
            Self::AlreadyRunning => "alreadyRunning",
        }
    }
}

/// `storage_setup`'s `mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupMode {
    Keyring,
    Passphrase,
}

/// `storage_unlock`'s `method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnlockMethod {
    Recovery,
    Passphrase,
}

/// The internal state machine. Never serialized directly — every public
/// method reports through [`StorageStatus`] instead, so the UI always
/// re-renders from one flat shape.
enum StorageState {
    NeedsSetup,
    Locked { locked: keyslots::Locked, reason: LockedReason },
    Unlocked { unlocked: keyslots::Unlocked },
    Unavailable { reason: UnavailableReason },
    /// Terminal for this process: [`StorageService::erase_all`] has run.
    /// Distinct from `NeedsSetup` so every other command can refuse with a
    /// clear "restart Snowdrop" error instead of quietly behaving as if
    /// nothing had ever been set up — the vault bridge and the
    /// single-instance lock are one-shot per process either way, so only a
    /// fresh process can actually return to `NeedsSetup`
    /// (docs/ENCRYPTION.md, "Erase").
    Erased,
    /// Terminal for this process: [`StorageService::sign_out`] has run.
    /// Like `Erased`, every other command refuses until a restart — but
    /// unlike `Erased`, `keys.json` and the keyring entry are left alone, so
    /// a fresh process finds storage already set up (and, with a working
    /// keyring, unlocks the same way it did before) around a freshly empty
    /// vault (docs/ENCRYPTION.md, "Sign out").
    SignedOut,
}

/// The one JSON shape every storage command returns (docs/ENCRYPTION.md;
/// task contract). `reason` is only present for `locked`/`unavailable`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub has_recovery: bool,
    pub has_passphrase: bool,
    pub has_keyring: bool,
    pub keyring_backend: &'static str,
    pub legacy_plaintext: bool,
    /// True when `SNOWDROP_SIGNAL_CLI_DATA` is set. The other half of this
    /// flag — an external daemon currently connected — lives outside this
    /// module (it needs `Service`, task 4b's territory); `commands.rs` ORs
    /// it in before handing the status to the UI.
    pub vault_disabled: bool,
    /// `true` only once [`StorageService::erase_all`] has run in this
    /// process: `state` still reads `"needsSetup"` (nothing is actually
    /// configured any more), but every other command refuses until the app
    /// restarts (docs/ENCRYPTION.md, "Erase").
    pub restart_required: bool,
}

/// The signal-cli vault, runtime dir and single-instance lock, handed over
/// once to task 4b so it can build a `vault::VaultSession` around them. The
/// lock moves out (it's `InstanceLock::acquire`'s whole point — exactly one
/// live holder at a time), so this can only ever be called once per unlock.
pub type VaultSessionParts = (Vault, PathBuf, InstanceLock);

/// What [`StorageService::begin_erase`] hands its caller: everything the
/// hooks (run with no lock held — phase 2) and
/// [`StorageService::finish_erase`] (phase 3, re-locked) need, captured while
/// phase 1 still held the lock.
pub struct ErasePrep {
    /// Run with no lock held on this service — see
    /// [`StorageService::begin_erase`].
    pub hooks: Vec<EraseHook>,
    keyring_entry: Option<String>,
}

pub struct StorageService<S: SecretStore = KeyringStore> {
    paths: StoragePaths,
    keyring_slot: KeyringSlot<S>,
    resolve_runtime_dir: RuntimeDirResolver,
    lock: Option<InstanceLock>,
    state: StorageState,
    on_erase: Vec<EraseHook>,
}

impl<S: SecretStore> StorageService<S> {
    pub fn new(paths: StoragePaths, keyring_store: S, resolve_runtime_dir: RuntimeDirResolver) -> Self {
        Self {
            paths,
            keyring_slot: KeyringSlot::new(keyring_store),
            resolve_runtime_dir,
            lock: None,
            state: StorageState::NeedsSetup,
            on_erase: Vec::new(),
        }
    }

    /// Registers a callback run (synchronously) between
    /// [`begin_erase`](Self::begin_erase)/[`begin_sign_out`](Self::begin_sign_out)
    /// and their `finish_*` counterparts, before anything is deleted — task
    /// 4b hangs the signal-cli shutdown and vault discard off this.
    pub fn add_on_erase(&mut self, hook: impl Fn() + Send + Sync + 'static) {
        self.on_erase.push(Arc::new(hook));
    }

    /// Called once at app start: takes the single-instance lock and loads
    /// `keys.json`, if any, to establish the initial state. Only the lock's
    /// `AlreadyRunning` failure becomes a state ([`UnavailableReason::AlreadyRunning`]);
    /// any other failure (e.g. the app data dir itself is unreadable) is a
    /// genuine startup error.
    pub fn setup(&mut self) -> Result<(), Error> {
        match InstanceLock::acquire(&self.paths.app_data_dir) {
            Ok(lock) => self.lock = Some(lock),
            Err(e) if e.kind == ErrorKind::AlreadyRunning => {
                self.state = StorageState::Unavailable { reason: UnavailableReason::AlreadyRunning };
                return Ok(());
            }
            Err(e) => return Err(e),
        }

        self.state = match keyslots::load(&self.paths.keys_path)? {
            None => StorageState::NeedsSetup,
            Some(locked) => {
                // A placeholder reason: `try_unlock_silently` below replaces
                // it with a real classification (or clears it entirely) on
                // its very first run.
                let reason = if locked.has_keyring() { LockedReason::KeyringUnavailable } else { LockedReason::PassphraseRequired };
                StorageState::Locked { locked, reason }
            }
        };
        self.try_unlock_silently();
        Ok(())
    }

    /// The status the UI renders from. Tries a silent keyring unlock first
    /// when storage is currently `Locked` with a keyring slot to try —
    /// covers both "a fresh process starts up with the keyring already
    /// available" and "the keyring that was locked a moment ago just got
    /// unlocked by the OS's own prompt".
    pub fn status(&mut self) -> StorageStatus {
        self.try_unlock_silently();
        self.build_status()
    }

    fn try_unlock_silently(&mut self) {
        let has_keyring = matches!(&self.state, StorageState::Locked { locked, .. } if locked.has_keyring());
        if !has_keyring {
            return;
        }
        let StorageState::Locked { locked, .. } = std::mem::replace(&mut self.state, StorageState::NeedsSetup) else {
            unreachable!("just matched Locked above")
        };
        match locked.unlock_keyring(&self.keyring_slot) {
            Ok(unlocked) => {
                if let Err(e) = self.finish_unlock(unlocked) {
                    log::warn!("storage: migration after a silent keyring unlock failed: {e}");
                }
            }
            Err(e) => self.state = StorageState::Locked { locked, reason: classify_keyring_error(e.kind) },
        }
    }

    fn build_status(&self) -> StorageStatus {
        let (has_keyring, has_recovery, has_passphrase) = self.flags();
        let legacy_plaintext = is_legacy_signal_cli_dir(&self.paths.app_data_dir);
        let (state, reason, restart_required) = match &self.state {
            StorageState::NeedsSetup => ("needsSetup", None, false),
            StorageState::Locked { reason, .. } => ("locked", Some(reason.as_str()), false),
            StorageState::Unlocked { .. } => ("unlocked", None, false),
            StorageState::Unavailable { reason } => ("unavailable", Some(reason.as_str()), false),
            StorageState::Erased => ("needsSetup", None, true),
            StorageState::SignedOut => ("needsSetup", None, true),
        };
        StorageStatus {
            state,
            reason,
            has_recovery,
            has_passphrase,
            has_keyring,
            keyring_backend: secrets::backend_name(),
            legacy_plaintext,
            vault_disabled: self.paths.external_override,
            restart_required,
        }
    }

    fn flags(&self) -> (bool, bool, bool) {
        match &self.state {
            StorageState::Locked { locked, .. } => (locked.has_keyring(), locked.has_recovery(), locked.has_passphrase()),
            StorageState::Unlocked { unlocked } => (unlocked.has_keyring(), unlocked.has_recovery(), unlocked.has_passphrase()),
            StorageState::NeedsSetup | StorageState::Unavailable { .. } | StorageState::Erased | StorageState::SignedOut => {
                // Best-effort: reading keys.json never needs the instance
                // lock, so this stays accurate even while `Unavailable`
                // (and, once erased, simply comes up empty — while, once
                // signed out, `keys.json` is still there to read).
                match keyslots::load(&self.paths.keys_path) {
                    Ok(Some(locked)) => (locked.has_keyring(), locked.has_recovery(), locked.has_passphrase()),
                    _ => (false, false, false),
                }
            }
        }
    }

    /// Every command but `status` refuses once storage has been erased or
    /// signed out of in this process — see [`StorageState::Erased`] and
    /// [`StorageState::SignedOut`].
    fn refuse_if_erased(&self) -> Result<(), Error> {
        match self.state {
            StorageState::Erased => Err(Error::new(ErrorKind::Config, "Local data was erased; restart Snowdrop to continue.")),
            StorageState::SignedOut => Err(Error::new(ErrorKind::Config, "Signed out; restart Snowdrop to continue.")),
            _ => Ok(()),
        }
    }

    /// The keyring account currently referenced by `keys.json`, if any —
    /// from whichever state actually has it in hand, falling back to a
    /// best-effort disk read the same way [`Self::flags`] does.
    fn current_keyring_entry(&self) -> Option<String> {
        match &self.state {
            StorageState::Locked { locked, .. } => locked.keyring_entry(),
            StorageState::Unlocked { unlocked } => unlocked.keyring_entry(),
            StorageState::NeedsSetup | StorageState::Unavailable { .. } | StorageState::Erased | StorageState::SignedOut => {
                keyslots::load(&self.paths.keys_path).ok().flatten().and_then(|locked| locked.keyring_entry())
            }
        }
    }

    /// `storage_setup`: first-time creation of `keys.json`. Fails if storage
    /// isn't currently `NeedsSetup`.
    pub fn setup_new(&mut self, mode: SetupMode, passphrase: Option<&str>) -> Result<StorageStatus, Error> {
        self.refuse_if_erased()?;
        if !matches!(self.state, StorageState::NeedsSetup) {
            return Err(Error::new(ErrorKind::Config, "Storage has already been set up."));
        }
        let unlocked = match mode {
            SetupMode::Keyring => keyslots::init_with_keyring(&self.paths.keys_path, &self.keyring_slot)?,
            SetupMode::Passphrase => {
                let passphrase = passphrase
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| Error::new(ErrorKind::Config, "A passphrase is required for passphrase mode."))?;
                keyslots::init_with_passphrase(&self.paths.keys_path, passphrase)?
            }
        };
        self.finish_unlock(unlocked)?;
        Ok(self.build_status())
    }

    /// `storage_unlock`. On a wrong secret, storage stays exactly as it was
    /// (nothing is written to `self.state`) and the `AuthFailed`/`SlotMissing`
    /// error propagates. With `remember`, a failed keyring enrolment is
    /// logged, not returned — the unlock itself already succeeded.
    pub fn unlock(&mut self, method: UnlockMethod, secret: &str, remember: bool) -> Result<StorageStatus, Error> {
        self.refuse_if_erased()?;
        let StorageState::Locked { locked, .. } = &self.state else {
            return Err(Error::new(ErrorKind::Config, "Storage isn't locked."));
        };
        let mut unlocked = match method {
            UnlockMethod::Recovery => locked.unlock_recovery(secret)?,
            UnlockMethod::Passphrase => locked.unlock_passphrase(secret)?,
        };
        if remember {
            match unlocked.enroll_keyring(&self.keyring_slot).and_then(|old_entry| {
                unlocked.save()?;
                Ok(old_entry)
            }) {
                Ok(Some(old_entry)) => {
                    if let Err(e) = self.keyring_slot.delete(&old_entry) {
                        log::warn!("storage: couldn't remove the superseded keyring entry: {e}");
                    }
                }
                Ok(None) => {}
                Err(e) => log::warn!("storage: couldn't remember this device (enrol a keyring slot): {e}"),
            }
        }
        self.finish_unlock(unlocked)?;
        Ok(self.build_status())
    }

    /// `storage_create_recovery`: returns the plaintext code exactly once.
    /// Never logged — callers must not log it either.
    pub fn create_recovery(&mut self) -> Result<(RecoveryCode, StorageStatus), Error> {
        self.refuse_if_erased()?;
        let StorageState::Unlocked { unlocked } = &mut self.state else {
            return Err(Error::new(ErrorKind::Config, "Storage must be unlocked to create a recovery code."));
        };
        let code = unlocked.add_recovery()?;
        unlocked.save()?;
        Ok((code, self.build_status()))
    }

    pub fn remove_recovery(&mut self) -> Result<StorageStatus, Error> {
        self.refuse_if_erased()?;
        let StorageState::Unlocked { unlocked } = &mut self.state else {
            return Err(Error::new(ErrorKind::Config, "Storage must be unlocked."));
        };
        unlocked.remove_recovery()?;
        unlocked.save()?;
        Ok(self.build_status())
    }

    pub fn set_passphrase(&mut self, passphrase: Option<&str>) -> Result<StorageStatus, Error> {
        self.refuse_if_erased()?;
        let StorageState::Unlocked { unlocked } = &mut self.state else {
            return Err(Error::new(ErrorKind::Config, "Storage must be unlocked."));
        };
        unlocked.set_passphrase(passphrase)?;
        unlocked.save()?;
        Ok(self.build_status())
    }

    pub fn enroll_keyring(&mut self) -> Result<StorageStatus, Error> {
        self.refuse_if_erased()?;
        let StorageState::Unlocked { unlocked } = &mut self.state else {
            return Err(Error::new(ErrorKind::Config, "Storage must be unlocked."));
        };
        let old_entry = unlocked.enroll_keyring(&self.keyring_slot)?;
        unlocked.save()?;
        if let Some(old_entry) = old_entry {
            if let Err(e) = self.keyring_slot.delete(&old_entry) {
                log::warn!("storage: couldn't remove the superseded keyring entry: {e}");
            }
        }
        Ok(self.build_status())
    }

    /// The 32-byte web cache key, only while `Unlocked` (docs/ENCRYPTION.md,
    /// "Web cache").
    pub fn webcache_key(&self) -> Option<[u8; 32]> {
        match &self.state {
            StorageState::Unlocked { unlocked } => Some(*unlocked.webcache_key().as_bytes()),
            _ => None,
        }
    }

    /// Hands the vault, its runtime dir and the single-instance lock to task
    /// 4b, which builds a `vault::VaultSession` around them. `None` when
    /// storage isn't `Unlocked`, the runtime dir can't be resolved, or this
    /// has already been called once (the lock only has one holder).
    pub fn vault_session_parts(&mut self) -> Option<VaultSessionParts> {
        let StorageState::Unlocked { unlocked } = &self.state else { return None };
        let vault_id = unlocked.vault_id().ok()?;
        let vault = Vault::open(&self.paths.vault_dir, unlocked.vault_key(), vault_id).ok()?;
        let runtime_dir = (self.resolve_runtime_dir)().ok()?;
        let lock = self.lock.take()?;
        Some((vault, runtime_dir, lock))
    }

    /// Phase 1 of `storage_erase_all` (docs/ENCRYPTION.md, "Erase"):
    /// validates the confirmation string and, before anything on disk is
    /// touched, captures the keyring account `keys.json` currently names —
    /// once `keys_path` is gone there's no other way to know which account
    /// was ours — plus the hooks to run. Nothing is deleted or latched yet.
    ///
    /// This takes `&self`, not `&mut self`, so `commands.rs`'s
    /// `storage_erase_all` can lock the outer `Mutex<StorageService>` just
    /// for this call, run the returned [`ErasePrep::hooks`] with that lock
    /// released, and only re-lock for [`finish_erase`](Self::finish_erase).
    /// That split fixes a real deadlock: a hook here (task 4b's
    /// stop-signal-cli-then-discard) calls back into `Service`, which locks
    /// its own `active` mutex to stop the backend — and `Service::connect`
    /// holds that very lock while calling back into storage to resolve the
    /// vault's spawn dir. Two locks taken in opposite orders on two threads
    /// deadlock the moment both are in flight together; never holding
    /// storage's lock while a hook runs breaks that cycle.
    pub fn begin_erase(&self, confirm: &str) -> Result<ErasePrep, Error> {
        self.refuse_if_erased()?;
        if confirm != "ERASE" {
            return Err(Error::new(ErrorKind::Config, "Type ERASE to confirm erasing all local data."));
        }
        Ok(ErasePrep { keyring_entry: self.current_keyring_entry(), hooks: self.on_erase.clone() })
    }

    /// Phase 3 of `storage_erase_all`, re-locked after phase 2 (the caller
    /// running `prep.hooks` with no lock held — see
    /// [`begin_erase`](Self::begin_erase)). Best-effort: every item is
    /// attempted even if an earlier one failed, and every failure is
    /// collected rather than surfaced as a hard stop. Leaves storage in the
    /// terminal [`StorageState::Erased`] state, not `NeedsSetup` — only a
    /// fresh process can return to that.
    pub fn finish_erase(&mut self, prep: ErasePrep) -> Result<(StorageStatus, Vec<String>), Error> {
        let mut failures = Vec::new();
        remove_dir_best_effort(&self.paths.vault_dir, &mut failures);
        if let Ok(runtime_dir) = (self.resolve_runtime_dir)() {
            remove_dir_best_effort(&runtime_dir, &mut failures);
        }
        remove_file_best_effort(&self.paths.keys_path, &mut failures);
        // Deletes the one account `keys.json` referenced. The `keyring`
        // crate exposes no cross-backend way to enumerate every
        // `keyslot-*` account for this service, so any other leftover from
        // an aborted enrolment is simply left behind — harmless, since
        // nothing references it (docs/ENCRYPTION.md, "Key hierarchy").
        if let Some(entry) = prep.keyring_entry {
            if let Err(e) = self.keyring_slot.delete(&entry) {
                failures.push(format!("keyring entry: {e}"));
            }
        }
        remove_dir_best_effort(&legacy_signal_cli_dir(&self.paths.app_data_dir), &mut failures);
        // The installed signal-cli binary (and any in-progress download) —
        // sign-out deliberately leaves this alone (see `bin_dir`'s docs), but
        // an erase wipes everything Snowdrop manages in the app data dir.
        remove_dir_best_effort(&bin_dir(&self.paths.app_data_dir), &mut failures);
        if let Some(log_file) = self.paths.log_file.clone() {
            remove_log_files_best_effort(&log_file, &mut failures);
        }

        // Erase and sign-out release the lock while their hooks run, so the
        // other may have finished first: an erase still wins over sign-out
        // (it deleted strictly more), and a terminal state is never undone.
        self.state = StorageState::Erased;
        Ok((self.build_status(), failures))
    }

    /// `begin_erase` + running the hooks + `finish_erase`, with nothing
    /// released in between: fine for a direct, single-threaded caller (this
    /// module's own tests below). `commands.rs`'s `storage_erase_all` calls
    /// `begin_erase`/`finish_erase` directly instead, with the lock released
    /// across the hooks — see [`begin_erase`](Self::begin_erase) for why.
    #[cfg(test)]
    pub fn erase_all(&mut self, confirm: &str) -> Result<(StorageStatus, Vec<String>), Error> {
        let prep = self.begin_erase(confirm)?;
        for hook in &prep.hooks {
            hook();
        }
        self.finish_erase(prep)
    }

    /// Phase 1 of `storage_sign_out` — the same split as, and for the same
    /// deadlock-avoiding reason as, [`begin_erase`](Self::begin_erase)/
    /// [`finish_erase`](Self::finish_erase): validates that storage is
    /// actually `Unlocked` and hands back the hooks to run with no lock held
    /// on this service.
    pub fn begin_sign_out(&self) -> Result<Vec<EraseHook>, Error> {
        self.refuse_if_erased()?;
        if !matches!(self.state, StorageState::Unlocked { .. }) {
            return Err(Error::new(ErrorKind::Config, "Storage must be unlocked to sign out."));
        }
        Ok(self.on_erase.clone())
    }

    /// Phase 3 of `storage_sign_out`, re-locked after phase 2 (the caller
    /// running the hooks [`begin_sign_out`](Self::begin_sign_out) returned,
    /// with no lock held): wipes the vault's manifests, blobs and RAM-backed
    /// runtime dir, but deliberately keeps `keys.json` and the keyring
    /// entry, so storage stays set up and (with a working keyring) unlocks
    /// the same way it did before, around a freshly empty vault. Like
    /// `finish_erase`, latches a terminal, restart-required state — the
    /// vault bridge and the single-instance lock are one-shot per process,
    /// so only a fresh process can open a vault again.
    pub fn finish_sign_out(&mut self) -> Result<StorageStatus, Error> {
        let mut failures = Vec::new();
        remove_dir_best_effort(&self.paths.vault_dir, &mut failures);
        if let Ok(runtime_dir) = (self.resolve_runtime_dir)() {
            remove_dir_best_effort(&runtime_dir, &mut failures);
        }
        // Like erase, the log is wiped too (it may hold a redacted trace of
        // this account's history) — only keys.json and the keyring entry
        // are left exactly as they are, the whole point of signing out
        // rather than erasing.
        if let Some(log_file) = self.paths.log_file.clone() {
            remove_log_files_best_effort(&log_file, &mut failures);
        }
        for failure in &failures {
            log::warn!("storage: sign out couldn't remove {failure}");
        }

        // First terminal state wins: don't overwrite an erase that finished
        // while this sign-out's hooks ran with the lock released.
        if !matches!(self.state, StorageState::Erased) {
            self.state = StorageState::SignedOut;
        }
        Ok(self.build_status())
    }

    /// `begin_sign_out` + running the hooks + `finish_sign_out`, with
    /// nothing released in between: fine for a direct, single-threaded
    /// caller (this module's own tests below). `commands.rs`'s
    /// `storage_sign_out` calls `begin_sign_out`/`finish_sign_out` directly
    /// instead, with the lock released across the hooks — see
    /// [`begin_erase`](Self::begin_erase) for why.
    #[cfg(test)]
    pub fn sign_out(&mut self) -> Result<StorageStatus, Error> {
        let hooks = self.begin_sign_out()?;
        for hook in &hooks {
            hook();
        }
        self.finish_sign_out()
    }

    /// Common tail of every path that reaches `Unlocked` (first-time setup,
    /// an explicit unlock, or a silent keyring one): commits the new state,
    /// then migrates a legacy plaintext signal-cli dir if one is waiting.
    fn finish_unlock(&mut self, unlocked: keyslots::Unlocked) -> Result<(), Error> {
        self.state = StorageState::Unlocked { unlocked };
        self.migrate_legacy_if_needed()
    }

    fn migrate_legacy_if_needed(&mut self) -> Result<(), Error> {
        let (vault_key, vault_id) = match &self.state {
            StorageState::Unlocked { unlocked } => (unlocked.vault_key(), unlocked.vault_id()?),
            _ => return Ok(()),
        };
        match self.migrate_legacy(vault_key, vault_id) {
            Ok(()) => Ok(()),
            Err(e) if e.kind == ErrorKind::NoRamDir => {
                self.state = StorageState::Unavailable { reason: UnavailableReason::NoRamDir };
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// docs/ENCRYPTION.md, "Migration": syncs the legacy dir straight into
    /// the vault (`Vault::sync` takes any dir, not just the real runtime
    /// one, and only ever reads `ALLOWED_TOP_DIRS` out of it — see that
    /// constant's docs), verifies by restoring into a scratch spot under the
    /// real RAM-backed runtime dir and comparing hashes, and only then
    /// deletes the four subtrees it imported. Skipped entirely when
    /// `SNOWDROP_SIGNAL_CLI_DATA` points signal-cli somewhere outside
    /// Snowdrop's management, when `legacy_dir` doesn't actually look like
    /// signal-cli's own data (no `data/` subdirectory —
    /// `is_legacy_signal_cli_dir`), or when the vault already has a
    /// manifest.
    fn migrate_legacy(&self, vault_key: Key32, vault_id: [u8; 16]) -> Result<(), Error> {
        if self.paths.external_override {
            return Ok(());
        }
        let legacy_dir = legacy_signal_cli_dir(&self.paths.app_data_dir);
        if !is_legacy_signal_cli_dir(&self.paths.app_data_dir) {
            return Ok(());
        }
        // Never migrate into a vault that already has a manifest: that
        // means an account was already linked and synced through Snowdrop,
        // and blindly importing a second, unrelated plaintext directory on
        // top of it could only corrupt or shadow real data. Leave the
        // legacy dir exactly as it is.
        if self.paths.vault_dir.join("manifest").exists() || self.paths.vault_dir.join("manifest.prev").exists() {
            log::warn!(
                "storage: a legacy plaintext signal-cli directory exists at {} but the vault already has a manifest; leaving it untouched.",
                legacy_dir.display()
            );
            return Ok(());
        }

        let vault = Vault::open(&self.paths.vault_dir, vault_key, vault_id)?;
        vault.sync(&legacy_dir)?;

        let runtime_dir = (self.resolve_runtime_dir)()?;
        let verify_dir = runtime_dir.join(".migration-verify");
        let _ = fs::remove_dir_all(&verify_dir);
        vault.restore(&verify_dir, |_| true)?;
        verify_migration(&legacy_dir, &verify_dir)?;
        fs::remove_dir_all(&verify_dir).map_err(|e| io_err(&verify_dir, e))?;

        // Only the subtrees `Vault::sync` actually imported are removed —
        // never the whole `legacy_dir` — since it may hold something else
        // Snowdrop doesn't manage, and migration must never delete that.
        for name in crate::vault::ALLOWED_TOP_DIRS {
            let subtree = legacy_dir.join(name);
            if subtree.exists() {
                fs::remove_dir_all(&subtree).map_err(|e| io_err(&subtree, e))?;
            }
        }
        log::info!("storage: migrated a legacy plaintext signal-cli directory into the vault.");
        Ok(())
    }
}

fn classify_keyring_error(kind: ErrorKind) -> LockedReason {
    match kind {
        ErrorKind::KeyringLocked => LockedReason::KeyringLocked,
        ErrorKind::KeyringUnavailable => LockedReason::KeyringUnavailable,
        // Corrupt, missing, or (in principle, though `has_keyring` already
        // gated this call) no slot at all, or a secret that's simply
        // wrong/stale: all point the unlock screen the same way — the
        // keyring can't open this vault right now.
        _ => LockedReason::KeyringSecretMissing,
    }
}

fn io_err(path: &Path, e: io::Error) -> Error {
    Error::new(ErrorKind::Internal, format!("{}: {e}", path.display()))
}

fn remove_dir_best_effort(dir: &Path, failures: &mut Vec<String>) {
    if let Err(e) = fs::remove_dir_all(dir) {
        if e.kind() != io::ErrorKind::NotFound {
            failures.push(format!("{}: {e}", dir.display()));
        }
    }
}

fn remove_file_best_effort(path: &Path, failures: &mut Vec<String>) {
    if let Err(e) = fs::remove_file(path) {
        if e.kind() != io::ErrorKind::NotFound {
            failures.push(format!("{}: {e}", path.display()));
        }
    }
}

/// Removes `log_file` and its rotated `.1` sibling (`logfile::LogFile`'s own
/// rotation scheme), best-effort. Shared by erase and sign-out: both must
/// leave no trace of this account's (possibly months of) history sitting
/// in the log, even though only erase also touches `keys.json` and the
/// keyring entry.
fn remove_log_files_best_effort(log_file: &Path, failures: &mut Vec<String>) {
    remove_file_best_effort(log_file, failures);
    let mut rotated = log_file.as_os_str().to_owned();
    rotated.push(".1");
    remove_file_best_effort(Path::new(&rotated), failures);
}

/// signal-cli's own sidecars, skipped on both sides of the comparison
/// (`vault::sync` never tracks them in the first place — see
/// `vault::sync`'s `is_sidecar` — so they'd otherwise look like files the
/// restore "lost").
fn is_sync_sidecar(name: &str) -> bool {
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

/// Confirms every file under `legacy_dir`'s allowlisted subtrees
/// (`vault::ALLOWED_TOP_DIRS` — the only ones `Vault::sync` ever reads) made
/// it into `restored_dir` with the same content. SQLite databases are
/// exempted from the byte-for-byte check: the online backup API
/// (docs/ENCRYPTION.md, "Sync") folds in any WAL content, so a `.db` file's
/// bytes can legitimately differ from the original even though the data is
/// unchanged. Every other file must match exactly.
fn verify_migration(legacy_dir: &Path, restored_dir: &Path) -> Result<(), Error> {
    let legacy = collect_allowlisted_file_hashes(legacy_dir)?;
    // `restored_dir` only ever holds allowlisted entries in the first place
    // (`Vault::restore` never restores anything else), so this needs no
    // equivalent filtering.
    let restored = collect_file_hashes(restored_dir)?;
    let mismatch = || {
        Error::new(ErrorKind::Internal, "signal-cli migration verification failed: the restored data doesn't match the legacy directory.")
    };
    if legacy.keys().collect::<Vec<_>>() != restored.keys().collect::<Vec<_>>() {
        return Err(mismatch());
    }
    for (relpath, legacy_hash) in &legacy {
        if relpath.ends_with(".db") {
            continue;
        }
        if restored.get(relpath) != Some(legacy_hash) {
            return Err(mismatch());
        }
    }
    Ok(())
}

/// Like [`collect_file_hashes`], but only descends into `dir`'s allowlisted
/// subtrees (`vault::ALLOWED_TOP_DIRS`) — so anything else `legacy_dir`
/// happens to hold (an installed binary, unrelated leftovers) never makes
/// migration's verification look like data loss, since it was never
/// migrated in the first place.
fn collect_allowlisted_file_hashes(dir: &Path) -> Result<BTreeMap<String, String>, Error> {
    let mut out = BTreeMap::new();
    for name in crate::vault::ALLOWED_TOP_DIRS {
        collect_file_hashes_into(dir, &dir.join(name), &mut out)?;
    }
    Ok(out)
}

fn collect_file_hashes(dir: &Path) -> Result<BTreeMap<String, String>, Error> {
    let mut out = BTreeMap::new();
    collect_file_hashes_into(dir, dir, &mut out)?;
    Ok(out)
}

fn collect_file_hashes_into(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), Error> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(dir, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err(dir, e))?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| io_err(&path, e))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_file_hashes_into(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_sync_sidecar(&name) {
            continue;
        }
        let Some(relpath) = path.strip_prefix(root).ok().and_then(|p| p.to_str()) else { continue };
        let bytes = fs::read(&path).map_err(|e| io_err(&path, e))?;
        out.insert(relpath.replace('\\', "/"), sha256_hex(&bytes));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::FakeStore;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // `Arc<FakeStore>` (via `secrets::SecretStore`'s blanket impl for `Arc<T>`)
    // lets two `StorageService`s in the same test share one fake keyring,
    // simulating "the same OS keyring, a different process".

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-storage-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    /// A runtime-dir resolver backed by an ordinary temp dir (not real
    /// tmpfs) — fine for tests, which never check the filesystem type
    /// itself (that's `vault::runtime`'s own, already-tested job).
    fn fake_runtime_resolver(dir: PathBuf) -> RuntimeDirResolver {
        Box::new(move || {
            fs::create_dir_all(&dir).map_err(|e| Error::new(ErrorKind::Internal, e.to_string()))?;
            Ok(dir.clone())
        })
    }

    fn always_no_ram_dir() -> RuntimeDirResolver {
        Box::new(|| Err(Error::new(ErrorKind::NoRamDir, "no RAM dir in this test")))
    }

    struct Fixture {
        base: tempfile::TempDir,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            Self { base: temp_dir(name) }
        }

        fn paths(&self) -> StoragePaths {
            self.paths_with_override(false)
        }

        fn paths_with_override(&self, external_override: bool) -> StoragePaths {
            StoragePaths::new(self.base.path().join("app-data"), Some(self.base.path().join("signal-cli.log")), external_override)
        }

        fn service(&self) -> StorageService<Arc<FakeStore>> {
            self.service_with(Arc::new(FakeStore::new()))
        }

        fn service_with(&self, store: Arc<FakeStore>) -> StorageService<Arc<FakeStore>> {
            let runtime = self.base.path().join("runtime");
            StorageService::new(self.paths(), store, fake_runtime_resolver(runtime))
        }

        fn service_with_override(&self) -> StorageService<Arc<FakeStore>> {
            let runtime = self.base.path().join("runtime");
            StorageService::new(self.paths_with_override(true), Arc::new(FakeStore::new()), fake_runtime_resolver(runtime))
        }

        fn service_no_ram_dir(&self) -> StorageService<Arc<FakeStore>> {
            StorageService::new(self.paths(), Arc::new(FakeStore::new()), always_no_ram_dir())
        }
    }

    #[test]
    fn needs_setup_with_nothing_on_disk() {
        let fx = Fixture::new("needs-setup");
        let mut svc = fx.service();
        svc.setup().unwrap();
        let status = svc.status();
        assert_eq!(status.state, "needsSetup");
        assert!(!status.has_keyring);
    }

    #[test]
    fn setup_then_status_is_unlocked() {
        let fx = Fixture::new("setup-unlocked");
        let mut svc = fx.service();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert_eq!(status.state, "unlocked");
        assert!(status.has_keyring);
        assert!(!status.has_recovery);
        assert!(!status.has_passphrase);
        assert_eq!(svc.status().state, "unlocked");
    }

    #[test]
    fn a_fresh_process_with_the_keyring_auto_unlocks() {
        let fx = Fixture::new("fresh-process");
        let store = Arc::new(FakeStore::new());

        let mut first = fx.service_with(store.clone());
        first.setup().unwrap();
        first.setup_new(SetupMode::Keyring, None).unwrap();
        drop(first); // the previous "process" exits, releasing the instance lock

        // A brand new `StorageService`, same paths, same (still-populated)
        // keyring: simulates relaunching the app.
        let mut second = fx.service_with(store);
        second.setup().unwrap();
        assert_eq!(second.status().state, "unlocked");
    }

    #[test]
    fn a_deleted_keyring_secret_locks_then_recovery_with_remember_reenrolls() {
        let fx = Fixture::new("secret-missing");
        let store = Arc::new(FakeStore::new());

        let mut first = fx.service_with(store.clone());
        first.setup().unwrap();
        first.setup_new(SetupMode::Keyring, None).unwrap();
        let (code, _) = first.create_recovery().unwrap();
        drop(first); // the previous "process" exits, releasing the instance lock

        // The keyring secret disappears (a wiped keyring, or a fresh
        // provider that took over): simulated with a brand new FakeStore.
        let fresh_store = Arc::new(FakeStore::new());
        let mut second = fx.service_with(fresh_store.clone());
        second.setup().unwrap();
        let status = second.status();
        assert_eq!(status.state, "locked");
        assert_eq!(status.reason, Some("keyringSecretMissing"));
        assert!(status.has_recovery);

        let status = second.unlock(UnlockMethod::Recovery, &code.to_string(), true).unwrap();
        assert_eq!(status.state, "unlocked");
        assert!(status.has_keyring);
        // The new keyring provider now holds a secret: a later relaunch
        // auto-unlocks through it too.
        assert_eq!(fresh_store.account_count(), 1);
        drop(second); // the previous "process" exits, releasing the instance lock
        let mut third = fx.service_with(fresh_store);
        third.setup().unwrap();
        assert_eq!(third.status().state, "unlocked");
    }

    #[test]
    fn passphrase_mode_locks_with_passphrase_required_and_unlocks() {
        let fx = Fixture::new("passphrase-mode");
        let mut first = fx.service();
        first.setup().unwrap();
        let status = first.setup_new(SetupMode::Passphrase, Some("a strong passphrase")).unwrap();
        assert_eq!(status.state, "unlocked");
        drop(first); // the previous "process" exits, releasing the instance lock

        let mut second = fx.service_with(Arc::new(FakeStore::new()));
        second.setup().unwrap();
        let status = second.status();
        assert_eq!(status.state, "locked");
        assert_eq!(status.reason, Some("passphraseRequired"));
        assert!(status.has_passphrase);
        assert!(!status.has_keyring);

        let status = second.unlock(UnlockMethod::Passphrase, "a strong passphrase", false).unwrap();
        assert_eq!(status.state, "unlocked");
    }

    #[test]
    fn a_wrong_secret_fails_and_leaves_the_state_unchanged() {
        let fx = Fixture::new("wrong-secret");
        let mut first = fx.service();
        first.setup().unwrap();
        first.setup_new(SetupMode::Passphrase, Some("correct one")).unwrap();
        drop(first); // the previous "process" exits, releasing the instance lock

        let mut second = fx.service_with(Arc::new(FakeStore::new()));
        second.setup().unwrap();
        assert_eq!(second.status().state, "locked");

        let err = second.unlock(UnlockMethod::Passphrase, "wrong one", false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
        // Still locked, not unlocked, not some half-transitioned state.
        assert_eq!(second.status().state, "locked");
    }

    #[test]
    fn erase_removes_every_artifact_and_returns_needs_setup() {
        let fx = Fixture::new("erase");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        svc.create_recovery().unwrap();

        let paths = fx.paths();
        assert!(paths.keys_path.exists(), "sanity: setup_new already wrote it");
        fs::create_dir_all(&paths.vault_dir).unwrap();
        let log_file = paths.log_file.as_ref().unwrap();
        fs::write(log_file, b"log").unwrap();
        let rotated_log = {
            let mut p = log_file.as_os_str().to_owned();
            p.push(".1");
            PathBuf::from(p)
        };
        fs::write(&rotated_log, b"older log").unwrap();
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("data"), b"legacy").unwrap();

        let called = Arc::new(AtomicUsize::new(0));
        let called2 = called.clone();
        svc.add_on_erase(move || {
            called2.fetch_add(1, Ordering::SeqCst);
        });

        let (status, failures) = svc.erase_all("ERASE").unwrap();
        assert!(failures.is_empty(), "unexpected failures: {failures:?}");
        assert_eq!(status.state, "needsSetup");
        assert_eq!(called.load(Ordering::SeqCst), 1);
        assert!(!paths.keys_path.exists());
        assert!(!paths.vault_dir.exists());
        assert!(!legacy_dir.exists());
        assert!(!log_file.exists());
        assert!(!rotated_log.exists(), "the rotated .1 log must be removed too");
    }

    #[test]
    fn erase_requires_the_exact_confirmation_string() {
        let fx = Fixture::new("erase-confirm");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        let err = svc.erase_all("erase").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert_eq!(svc.status().state, "unlocked");
    }

    #[test]
    fn migration_imports_verifies_and_deletes_the_legacy_dir() {
        let fx = Fixture::new("migration");
        let paths = fx.paths();
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(legacy_dir.join("attachments")).unwrap();
        fs::create_dir_all(legacy_dir.join("data")).unwrap();
        fs::write(legacy_dir.join("data/account"), b"the account file").unwrap();
        fs::write(legacy_dir.join("attachments/one.jpg"), b"fake jpeg bytes").unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();

        assert_eq!(status.state, "unlocked");
        assert!(!status.legacy_plaintext, "the legacy dir must be gone once migration succeeds");
        // Only the allowlisted subtrees are removed, not necessarily the
        // (now-empty) legacy dir itself.
        assert!(!legacy_dir.join("data").exists());
        assert!(!legacy_dir.join("attachments").exists());

        // And it's really in the vault, not just deleted: a session started
        // fresh against the same paths restores it.
        let (vault, runtime_dir, _lock) = svc.vault_session_parts().unwrap();
        let restored = fx.base.path().join("migration-check");
        vault.restore(&restored, |_| true).unwrap();
        assert_eq!(fs::read(restored.join("data/account")).unwrap(), b"the account file");
        assert_eq!(fs::read(restored.join("attachments/one.jpg")).unwrap(), b"fake jpeg bytes");
        let _ = runtime_dir; // just proving it resolved
    }

    #[test]
    fn migration_is_skipped_when_the_external_override_is_set() {
        let fx = Fixture::new("migration-skip");
        let paths = fx.paths_with_override(true);
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(legacy_dir.join("data")).unwrap();
        fs::write(legacy_dir.join("data/account"), b"left alone").unwrap();

        let mut svc = fx.service_with_override();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();

        assert_eq!(status.state, "unlocked");
        assert!(status.vault_disabled);
        assert!(legacy_dir.exists(), "migration must not touch it when the override is set");
    }

    #[test]
    fn already_running_is_reported_without_touching_keys_json() {
        let fx = Fixture::new("already-running");
        let mut first = fx.service();
        first.setup().unwrap();

        let mut second = fx.service_with(Arc::new(FakeStore::new()));
        second.setup().unwrap(); // setup() itself never errors for AlreadyRunning: it's a state, not an Err
        assert_eq!(second.status().state, "unavailable");
        assert_eq!(second.status().reason, Some("alreadyRunning"));
    }

    #[test]
    fn no_ram_dir_surfaces_as_unavailable_during_migration() {
        let fx = Fixture::new("no-ram-dir");
        let paths = fx.paths();
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(legacy_dir.join("data")).unwrap();
        fs::write(legacy_dir.join("data/account"), b"stuck").unwrap();

        let mut svc = fx.service_no_ram_dir();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert_eq!(status.state, "unavailable");
        assert_eq!(status.reason, Some("noRamDir"));
        assert!(legacy_dir.exists(), "nothing was deleted since migration never completed");
    }

    #[test]
    fn webcache_key_only_while_unlocked() {
        let fx = Fixture::new("webcache-key");
        let mut svc = fx.service();
        assert!(svc.webcache_key().is_none());
        svc.setup().unwrap();
        assert!(svc.webcache_key().is_none());
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert!(svc.webcache_key().is_some());
    }

    #[test]
    fn remove_recovery_and_set_passphrase_update_the_flags() {
        let fx = Fixture::new("flags");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        svc.create_recovery().unwrap();
        assert!(svc.status().has_recovery);
        svc.remove_recovery().unwrap();
        assert!(!svc.status().has_recovery);

        svc.set_passphrase(Some("a passphrase")).unwrap();
        assert!(svc.status().has_passphrase);
        svc.set_passphrase(None).unwrap();
        assert!(!svc.status().has_passphrase);
    }

    #[test]
    fn erase_removes_the_keyring_entry_from_the_store() {
        let fx = Fixture::new("erase-keyring-entry");
        let store = Arc::new(FakeStore::new());
        let mut svc = fx.service_with(store.clone());
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert_eq!(store.account_count(), 1);
        svc.erase_all("ERASE").unwrap();
        assert_eq!(store.account_count(), 0);
    }

    #[test]
    fn enroll_keyring_deletes_the_superseded_entry_once_saved() {
        let fx = Fixture::new("enroll-cleanup");
        let store = Arc::new(FakeStore::new());
        let mut svc = fx.service_with(store.clone());
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert_eq!(store.account_count(), 1);
        svc.enroll_keyring().unwrap();
        assert_eq!(store.account_count(), 1, "the superseded account is deleted, not just orphaned");
        svc.enroll_keyring().unwrap();
        assert_eq!(store.account_count(), 1);
    }

    #[test]
    fn erase_moves_to_an_erased_state_that_requires_a_restart() {
        let fx = Fixture::new("erase-latch");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();

        let (status, _failures) = svc.erase_all("ERASE").unwrap();
        assert_eq!(status.state, "needsSetup");
        assert!(status.restart_required);
        // `status` itself never refuses, and keeps reporting the latch.
        assert_eq!(svc.status().state, "needsSetup");
        assert!(svc.status().restart_required);

        // Every other command refuses now.
        assert_eq!(svc.setup_new(SetupMode::Keyring, None).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.unlock(UnlockMethod::Passphrase, "x", false).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.create_recovery().unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.remove_recovery().unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.set_passphrase(Some("x")).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.enroll_keyring().unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.erase_all("ERASE").unwrap_err().kind, ErrorKind::Config);
    }

    #[test]
    fn sign_out_keeps_keys_json_and_the_keyring_entry_but_wipes_the_vault() {
        let fx = Fixture::new("sign-out");
        let store = Arc::new(FakeStore::new());
        let mut svc = fx.service_with(store.clone());
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();

        let paths = fx.paths();
        fs::create_dir_all(&paths.vault_dir).unwrap();
        fs::write(paths.vault_dir.join("manifest"), b"fake manifest").unwrap();
        let runtime_dir = fx.base.path().join("runtime");
        fs::create_dir_all(&runtime_dir).unwrap();
        fs::write(runtime_dir.join("data"), b"live signal-cli data").unwrap();
        let log_file = paths.log_file.as_ref().unwrap();
        fs::write(log_file, b"log").unwrap();
        let rotated_log = {
            let mut p = log_file.as_os_str().to_owned();
            p.push(".1");
            PathBuf::from(p)
        };
        fs::write(&rotated_log, b"older log").unwrap();

        let called = Arc::new(AtomicUsize::new(0));
        let called2 = called.clone();
        svc.add_on_erase(move || {
            called2.fetch_add(1, Ordering::SeqCst);
        });

        let status = svc.sign_out().unwrap();
        assert_eq!(status.state, "needsSetup");
        assert!(status.restart_required);
        assert_eq!(called.load(Ordering::SeqCst), 1, "the stop-signal-cli/discard hook must run, like erase_all's");

        assert!(paths.keys_path.exists(), "keys.json must survive a sign-out");
        assert_eq!(store.account_count(), 1, "the keyring entry must survive a sign-out");
        assert!(!paths.vault_dir.exists(), "the vault (manifests and blobs) must be wiped");
        assert!(!runtime_dir.exists(), "the runtime dir must be wiped");
        assert!(!log_file.exists(), "the log must be wiped on sign-out too, not just erase");
        assert!(!rotated_log.exists(), "the rotated .1 log must be wiped too");
    }

    #[test]
    fn sign_out_latches_a_restart_required_state_that_refuses_every_other_command() {
        let fx = Fixture::new("sign-out-latch");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();

        svc.sign_out().unwrap();
        assert!(svc.status().restart_required);

        assert_eq!(svc.unlock(UnlockMethod::Passphrase, "x", false).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.create_recovery().unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.set_passphrase(Some("x")).unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.erase_all("ERASE").unwrap_err().kind, ErrorKind::Config);
        assert_eq!(svc.sign_out().unwrap_err().kind, ErrorKind::Config);
    }

    #[test]
    fn an_installed_binary_survives_two_unlocks_and_the_account_data_stays_restorable() {
        // Reproduces the real data-loss bug this task fixes: before it,
        // `signal_cli_install.rs` installed a downloaded binary at the exact
        // path (`<app data>/signal-cli/<version>/signal-cli`) that
        // `legacy_signal_cli_dir` treated as a legacy plaintext signal-cli
        // data dir. Every unlock synced the binary into the vault,
        // garbage-collected the real account data's now-unreferenced blobs,
        // and deleted the "legacy dir" — taking the just-installed binary
        // with it. Net effect: the account was lost and the binary had to
        // be re-downloaded, every single launch.
        let fx = Fixture::new("regression-binary-survives-unlock");
        let paths = fx.paths();

        // An installed signal-cli binary, at its real (post-fix) location
        // under `bin/` — a sibling of, not inside, `<app data>/signal-cli/`.
        let installed_binary = crate::signal_cli_install::install_dir(&paths.app_data_dir, "0.14.8").join("signal-cli");
        fs::create_dir_all(installed_binary.parent().unwrap()).unwrap();
        fs::write(&installed_binary, vec![0xABu8; 4096]).unwrap(); // stands in for the real ~370 MB binary

        let store = Arc::new(FakeStore::new());

        // ---- First "launch": set up storage, build a vault session, and
        // have "signal-cli" write some real account data into the runtime
        // dir, then shut down (final sync, then wipe). ----
        let mut first = fx.service_with(store.clone());
        first.setup().unwrap();
        first.setup_new(SetupMode::Keyring, None).unwrap();
        assert!(installed_binary.exists(), "sanity: setup must not touch the installed binary");

        let (vault, runtime_dir, lock) = first.vault_session_parts().unwrap();
        let session = crate::vault::VaultSession::start(vault, runtime_dir, lock).unwrap();
        fs::create_dir_all(session.runtime_dir().join("data")).unwrap();
        fs::write(session.runtime_dir().join("data/account"), b"the account file").unwrap();
        session.shutdown().unwrap();

        assert!(installed_binary.exists(), "the installed binary must survive the first unlock/session");
        drop(first); // the "process" exits, releasing the instance lock

        // ---- Second "launch": a brand new process, same app data dir,
        // same keyring secret — unlocking (and building a vault session)
        // a second time. ----
        let mut second = fx.service_with(store);
        second.setup().unwrap();
        assert_eq!(second.status().state, "unlocked");
        assert!(installed_binary.exists(), "the installed binary must survive the second unlock too");

        let (vault2, runtime_dir2, lock2) = second.vault_session_parts().unwrap();
        let session2 = crate::vault::VaultSession::start(vault2, runtime_dir2, lock2).unwrap();
        assert_eq!(
            fs::read(session2.runtime_dir().join("data/account")).unwrap(),
            b"the account file",
            "the account data must still be restorable after two unlocks"
        );
        assert!(installed_binary.exists(), "restoring the second session must not touch the installed binary either");
    }

    #[test]
    fn sign_out_keeps_the_installed_signal_cli_binary() {
        let fx = Fixture::new("sign-out-bin-dir");
        let paths = fx.paths();
        let bin = bin_dir(&paths.app_data_dir);
        let installed_binary = bin.join("signal-cli/0.14.8/signal-cli");
        fs::create_dir_all(installed_binary.parent().unwrap()).unwrap();
        fs::write(&installed_binary, b"installed binary").unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();

        svc.sign_out().unwrap();
        assert!(installed_binary.exists(), "sign-out must not remove the installed signal-cli binary");
    }

    #[test]
    fn erase_removes_the_installed_signal_cli_binary() {
        let fx = Fixture::new("erase-bin-dir");
        let paths = fx.paths();
        let bin = bin_dir(&paths.app_data_dir);
        let installed_binary = bin.join("signal-cli/0.14.8/signal-cli");
        fs::create_dir_all(installed_binary.parent().unwrap()).unwrap();
        fs::write(&installed_binary, b"installed binary").unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Keyring, None).unwrap();

        svc.erase_all("ERASE").unwrap();
        assert!(!bin.exists(), "erase must remove the installed signal-cli binary along with everything else it manages");
    }

    #[test]
    fn legacy_detection_requires_a_data_subdirectory() {
        let fx = Fixture::new("legacy-detection-needs-data-dir");
        let paths = fx.paths();
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        // Exactly what `signal_cli_install.rs` used to put at this same path
        // before it moved installs under `bin/`: a version directory with a
        // `signal-cli` executable inside, no `data/` anywhere.
        fs::create_dir_all(legacy_dir.join("0.14.8")).unwrap();
        fs::write(legacy_dir.join("0.14.8/signal-cli"), vec![0u8; 1024]).unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        assert!(!svc.status().legacy_plaintext, "a directory with no data/ subdirectory must never be treated as legacy signal-cli data");

        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();
        assert_eq!(status.state, "unlocked");
        assert!(legacy_dir.join("0.14.8/signal-cli").exists(), "the installed binary must survive unlock untouched");
        assert!(!svc.status().legacy_plaintext);
    }

    #[test]
    fn migration_is_skipped_when_the_vault_already_has_a_manifest() {
        let fx = Fixture::new("migration-existing-manifest");
        let paths = fx.paths();
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(legacy_dir.join("data")).unwrap();
        fs::write(legacy_dir.join("data/account"), b"should never be imported").unwrap();

        // A vault that already has a manifest — as if an account had
        // already been linked and synced through Snowdrop.
        fs::create_dir_all(&paths.vault_dir).unwrap();
        fs::write(paths.vault_dir.join("manifest"), b"an existing sealed manifest").unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();

        assert_eq!(status.state, "unlocked");
        assert!(legacy_dir.join("data/account").exists(), "the legacy dir must be left untouched when the vault already has a manifest");
        assert_eq!(
            fs::read(paths.vault_dir.join("manifest")).unwrap(),
            b"an existing sealed manifest",
            "the existing manifest must not be overwritten by the skipped migration"
        );
    }

    #[test]
    fn sign_out_requires_being_unlocked() {
        let fx = Fixture::new("sign-out-requires-unlocked");
        let mut svc = fx.service();
        svc.setup().unwrap();
        assert_eq!(svc.status().state, "needsSetup");
        let err = svc.sign_out().unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
    }

    #[test]
    fn a_new_empty_vault_works_after_signing_out_and_restarting() {
        let fx = Fixture::new("sign-out-fresh-vault");
        let store = Arc::new(FakeStore::new());

        let mut first = fx.service_with(store.clone());
        first.setup().unwrap();
        first.setup_new(SetupMode::Keyring, None).unwrap();
        let paths = fx.paths();
        fs::create_dir_all(&paths.vault_dir).unwrap();
        fs::write(paths.vault_dir.join("manifest"), b"old vault data").unwrap();
        first.sign_out().unwrap();
        drop(first); // the previous "process" exits, releasing the instance lock

        // A brand new `StorageService`, same paths, same (still-populated)
        // keyring: simulates relaunching the app after signing out.
        let mut second = fx.service_with(store);
        second.setup().unwrap();
        let status = second.status();
        assert_eq!(status.state, "unlocked", "keys.json survived, so the same keyring unlocks it again");
        assert!(!status.restart_required);

        let (vault, _runtime_dir, _lock) = second.vault_session_parts().unwrap();
        let report = vault.restore(&fx.base.path().join("restore-check"), |_| true).unwrap();
        assert_eq!(report.restored, 0, "the new vault must come up empty, not carry over the old manifest");
    }

    #[test]
    fn last_unlock_method_is_refused_for_passphrase_only_and_recovery_plus_passphrase() {
        // Passphrase-only: it's the one and only slot.
        let fx = Fixture::new("last-slot-passphrase-only");
        let mut svc = fx.service();
        svc.setup().unwrap();
        svc.setup_new(SetupMode::Passphrase, Some("the only way in")).unwrap();
        let err = svc.set_passphrase(None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::LastUnlockMethod);
        assert!(svc.status().has_passphrase);

        // Recovery-plus-passphrase: removing one is fine (the other
        // remains); removing the one left after that is refused.
        let fx2 = Fixture::new("last-slot-recovery-plus-passphrase");
        let mut svc2 = fx2.service();
        svc2.setup().unwrap();
        svc2.setup_new(SetupMode::Passphrase, Some("a passphrase")).unwrap();
        svc2.create_recovery().unwrap();
        svc2.remove_recovery().unwrap();
        assert!(!svc2.status().has_recovery);
        assert!(svc2.status().has_passphrase);
        let err = svc2.set_passphrase(None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::LastUnlockMethod);
        assert!(svc2.status().has_passphrase);
    }
}
