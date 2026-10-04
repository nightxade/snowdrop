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

use crate::aead::Key32;
use crate::error::{Error, ErrorKind};
use crate::keyslots::{self, RecoveryCode};
use crate::secrets::{self, KeyringSlot, KeyringStore, SecretStore};
use crate::vault::{InstanceLock, Vault};

/// Resolves the RAM-backed signal-cli runtime dir (`vault::resolve_runtime_dir`
/// in production; a temp-dir closure in tests).
pub type RuntimeDirResolver = Box<dyn Fn() -> Result<PathBuf, Error> + Send + Sync>;

/// A hook run (synchronously) at the start of [`StorageService::erase_all`],
/// before anything is deleted. Task 4b hangs the signal-cli shutdown off
/// this, since storage itself knows nothing about the running process.
pub type EraseHook = Box<dyn Fn() + Send + Sync>;

/// Where `keys.json` and the vault live, plus the signal-cli log (deleted by
/// [`StorageService::erase_all`]). All under the Tauri app data dir.
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

    /// Registers a callback run (synchronously) at the start of
    /// [`erase_all`](Self::erase_all), before anything is deleted — task 4b
    /// hangs the signal-cli shutdown off this.
    pub fn add_on_erase(&mut self, hook: impl Fn() + Send + Sync + 'static) {
        self.on_erase.push(Box::new(hook));
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
        let legacy_plaintext = legacy_signal_cli_dir(&self.paths.app_data_dir).is_dir();
        let (state, reason, restart_required) = match &self.state {
            StorageState::NeedsSetup => ("needsSetup", None, false),
            StorageState::Locked { reason, .. } => ("locked", Some(reason.as_str()), false),
            StorageState::Unlocked { .. } => ("unlocked", None, false),
            StorageState::Unavailable { reason } => ("unavailable", Some(reason.as_str()), false),
            StorageState::Erased => ("needsSetup", None, true),
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
            StorageState::NeedsSetup | StorageState::Unavailable { .. } | StorageState::Erased => {
                // Best-effort: reading keys.json never needs the instance
                // lock, so this stays accurate even while `Unavailable`
                // (and, once erased, simply comes up empty).
                match keyslots::load(&self.paths.keys_path) {
                    Ok(Some(locked)) => (locked.has_keyring(), locked.has_recovery(), locked.has_passphrase()),
                    _ => (false, false, false),
                }
            }
        }
    }

    /// Every command but `status` refuses once storage has been erased in
    /// this process — see [`StorageState::Erased`].
    fn refuse_if_erased(&self) -> Result<(), Error> {
        if matches!(self.state, StorageState::Erased) {
            return Err(Error::new(ErrorKind::Config, "Local data was erased; restart Snowdrop to continue."));
        }
        Ok(())
    }

    /// The keyring account currently referenced by `keys.json`, if any —
    /// from whichever state actually has it in hand, falling back to a
    /// best-effort disk read the same way [`Self::flags`] does.
    fn current_keyring_entry(&self) -> Option<String> {
        match &self.state {
            StorageState::Locked { locked, .. } => locked.keyring_entry(),
            StorageState::Unlocked { unlocked } => unlocked.keyring_entry(),
            StorageState::NeedsSetup | StorageState::Unavailable { .. } | StorageState::Erased => {
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

    /// `storage_erase_all`. Best-effort: every item is attempted even if an
    /// earlier one failed, and every failure is collected rather than
    /// surfaced as a hard stop. Doesn't stop signal-cli itself — that's
    /// whatever task 4b registered via [`add_on_erase`](Self::add_on_erase).
    /// Leaves storage in the terminal [`StorageState::Erased`] state, not
    /// `NeedsSetup` — only a fresh process can return to that.
    pub fn erase_all(&mut self, confirm: &str) -> Result<(StorageStatus, Vec<String>), Error> {
        self.refuse_if_erased()?;
        if confirm != "ERASE" {
            return Err(Error::new(ErrorKind::Config, "Type ERASE to confirm erasing all local data."));
        }
        // Captured before anything on disk is touched: once `keys_path` is
        // gone, there's no other way to know which keyring account was ours.
        let keyring_entry = self.current_keyring_entry();
        for hook in &self.on_erase {
            hook();
        }

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
        if let Some(entry) = keyring_entry {
            if let Err(e) = self.keyring_slot.delete(&entry) {
                failures.push(format!("keyring entry: {e}"));
            }
        }
        remove_dir_best_effort(&legacy_signal_cli_dir(&self.paths.app_data_dir), &mut failures);
        if let Some(log_file) = self.paths.log_file.clone() {
            remove_file_best_effort(&log_file, &mut failures);
        }

        self.state = StorageState::Erased;
        Ok((self.build_status(), failures))
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
    /// one), verifies by restoring into a scratch spot under the real
    /// RAM-backed runtime dir and comparing hashes, and only then deletes
    /// the legacy dir. Skipped entirely when `SNOWDROP_SIGNAL_CLI_DATA`
    /// points signal-cli somewhere outside Snowdrop's management.
    fn migrate_legacy(&self, vault_key: Key32, vault_id: [u8; 16]) -> Result<(), Error> {
        if self.paths.external_override {
            return Ok(());
        }
        let legacy_dir = legacy_signal_cli_dir(&self.paths.app_data_dir);
        if !legacy_dir.is_dir() {
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

        fs::remove_dir_all(&legacy_dir).map_err(|e| io_err(&legacy_dir, e))?;
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

/// signal-cli's own sidecars, skipped on both sides of the comparison
/// (`vault::sync` never tracks them in the first place — see
/// `vault::sync`'s `is_sidecar` — so they'd otherwise look like files the
/// restore "lost").
fn is_sync_sidecar(name: &str) -> bool {
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

/// Confirms every file under `legacy_dir` made it into `restored_dir` with
/// the same content. SQLite databases are exempted from the byte-for-byte
/// check: the online backup API (docs/ENCRYPTION.md, "Sync") folds in any
/// WAL content, so a `.db` file's bytes can legitimately differ from the
/// original even though the data is unchanged. Every other file must match
/// exactly.
fn verify_migration(legacy_dir: &Path, restored_dir: &Path) -> Result<(), Error> {
    let legacy = collect_file_hashes(legacy_dir)?;
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

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-storage-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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
        base: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            Self { base: temp_dir(name) }
        }

        fn paths(&self) -> StoragePaths {
            self.paths_with_override(false)
        }

        fn paths_with_override(&self, external_override: bool) -> StoragePaths {
            StoragePaths::new(self.base.join("app-data"), Some(self.base.join("signal-cli.log")), external_override)
        }

        fn service(&self) -> StorageService<Arc<FakeStore>> {
            self.service_with(Arc::new(FakeStore::new()))
        }

        fn service_with(&self, store: Arc<FakeStore>) -> StorageService<Arc<FakeStore>> {
            let runtime = self.base.join("runtime");
            StorageService::new(self.paths(), store, fake_runtime_resolver(runtime))
        }

        fn service_with_override(&self) -> StorageService<Arc<FakeStore>> {
            let runtime = self.base.join("runtime");
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
        fs::write(paths.log_file.as_ref().unwrap(), b"log").unwrap();
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
        assert!(!paths.log_file.as_ref().unwrap().exists());
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
        fs::write(legacy_dir.join("data"), b"the account file").unwrap();
        fs::write(legacy_dir.join("attachments/one.jpg"), b"fake jpeg bytes").unwrap();

        let mut svc = fx.service();
        svc.setup().unwrap();
        let status = svc.setup_new(SetupMode::Keyring, None).unwrap();

        assert_eq!(status.state, "unlocked");
        assert!(!status.legacy_plaintext, "the legacy dir must be gone once migration succeeds");
        assert!(!legacy_dir.exists());

        // And it's really in the vault, not just deleted: a session started
        // fresh against the same paths restores it.
        let (vault, runtime_dir, _lock) = svc.vault_session_parts().unwrap();
        let restored = fx.base.join("migration-check");
        vault.restore(&restored, |_| true).unwrap();
        assert_eq!(fs::read(restored.join("data")).unwrap(), b"the account file");
        assert_eq!(fs::read(restored.join("attachments/one.jpg")).unwrap(), b"fake jpeg bytes");
        let _ = runtime_dir; // just proving it resolved
    }

    #[test]
    fn migration_is_skipped_when_the_external_override_is_set() {
        let fx = Fixture::new("migration-skip");
        let paths = fx.paths_with_override(true);
        let legacy_dir = legacy_signal_cli_dir(&paths.app_data_dir);
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("data"), b"left alone").unwrap();

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
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("data"), b"stuck").unwrap();

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
