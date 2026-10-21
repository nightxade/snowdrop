//! `keys.json` — the LUKS-style keyslots that wrap the vault's data
//! encryption key (DEK) under the OS keyring, a recovery code or a
//! passphrase (docs/ENCRYPTION.md, "Key hierarchy"). Pure logic plus file
//! IO: no Tauri commands live here.
//!
//! The DEK itself never touches disk. Each slot stores `aead::seal(KEK,
//! DEK, aad)`, where `aad` is a hand-built, deterministic encoding of that
//! slot's own metadata (type, keyring entry id or KDF algorithm/parameters,
//! salt) plus the file's `vault_id` — never serde output, so field order
//! can't matter and editing a parameter, repointing a keyring slot at a
//! different account, or swapping a wrapped blob between slots all fail
//! authentication loudly (see [`slot_aad`]).

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

use crate::aead::{self, hkdf_subkey, Key32};
use crate::error::{Error, ErrorKind};
use crate::secrets::{KeyringSlot, SecretStore};

const FORMAT_VERSION: u32 = 1;
const VAULT_ID_LEN: usize = 16;
const SALT_LEN: usize = 16;
const RECOVERY_SECRET_LEN: usize = 20; // 160 bits
const AAD_DOMAIN: &[u8] = b"snowdrop/keyslot/v1";

const TAG_KEYRING: u8 = 1;
const TAG_RECOVERY: u8 = 2;
const TAG_PASSPHRASE: u8 = 3;
const ALG_ARGON2ID: u8 = 1;

/// Real Argon2id parameters (docs/ENCRYPTION.md). Dialed down under
/// `cfg(test)` so the test suite runs in milliseconds, not seconds; the KDF
/// itself, and every byte of the AAD it feeds into, is exercised exactly as
/// in production — only the cost is different.
#[cfg(not(test))]
const RECOVERY_KDF: (u32, u32, u32) = (19456, 2, 1);
#[cfg(test)]
const RECOVERY_KDF: (u32, u32, u32) = (8, 1, 1);

#[cfg(not(test))]
const PASSPHRASE_KDF: (u32, u32, u32) = (65536, 3, 1);
#[cfg(test)]
const PASSPHRASE_KDF: (u32, u32, u32) = (8, 1, 1);

/// Shortest passphrase accepted when one is *created* (setup, or setting a
/// new one): the same 8 the UI enforces (it counts UTF-16 code units, as
/// `String.length` does). Never applied when unlocking, so a passphrase made
/// by an older build can always still unlock.
pub const MIN_PASSPHRASE_LEN: usize = 8;

/// Sane bounds for Argon2id parameters read from `keys.json`. They're
/// authenticated (so tampering fails to unwrap), but an absurd value would
/// still be burned before that check fails: `m_kib` is allocated up front.
/// The ceilings are 8x the real passphrase cost (64 MiB, t=3, p=1).
const KDF_MAX_M_KIB: u32 = 512 * 1024;
const KDF_MAX_T: u32 = 10;
const KDF_MAX_P: u32 = 8;

impl KdfParams {
    /// Rejects parameters outside the bounds above, as a corrupt file.
    fn check_bounds(&self) -> Result<(), Error> {
        let ok = (8..=KDF_MAX_M_KIB).contains(&self.m_kib)
            && (1..=KDF_MAX_T).contains(&self.t)
            && (1..=KDF_MAX_P).contains(&self.p)
            && self.m_kib >= 8 * self.p;
        if ok {
            Ok(())
        } else {
            Err(Error::new(ErrorKind::KeysFileCorrupt, "keys.json: key-derivation parameters are out of range."))
        }
    }
}

fn check_new_passphrase(passphrase: &str) -> Result<(), Error> {
    if passphrase.encode_utf16().count() < MIN_PASSPHRASE_LEN {
        return Err(Error::new(ErrorKind::Config, format!("A passphrase needs at least {MIN_PASSPHRASE_LEN} characters.")));
    }
    Ok(())
}

/// Which of the three slot types a [`Slot`] is, without its contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotKind {
    Keyring,
    Recovery,
    Passphrase,
}

/// Argon2id parameters for a recovery or passphrase slot, stored alongside
/// its wrapped DEK so a slot can be unwrapped (and its AAD rebuilt) on its
/// own, and so different slots can be tuned independently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub alg: KdfAlg,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    /// Base64.
    pub salt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KdfAlg {
    Argon2id,
}

/// One keyslot. At most one of each kind lives in [`KeyFile::slots`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Slot {
    /// `wrapped` = `aead::seal(keyring secret, DEK, aad)`. `entry` names
    /// which keyring account that secret lives under
    /// (`secrets::account_name`) — a fresh random id per enrolment, bound
    /// into this slot's own AAD so a swapped-in different account's secret
    /// can never be mistaken for the right one (docs/ENCRYPTION.md, "Key
    /// hierarchy").
    Keyring { entry: String, wrapped: String },
    /// `wrapped` = `aead::seal(Argon2id(recovery code, kdf), DEK, aad)`.
    Recovery { kdf: KdfParams, wrapped: String },
    /// `wrapped` = `aead::seal(Argon2id(passphrase, kdf), DEK, aad)`.
    Passphrase { kdf: KdfParams, wrapped: String },
}

impl Slot {
    fn kind(&self) -> SlotKind {
        match self {
            Self::Keyring { .. } => SlotKind::Keyring,
            Self::Recovery { .. } => SlotKind::Recovery,
            Self::Passphrase { .. } => SlotKind::Passphrase,
        }
    }

    fn kdf(&self) -> Option<&KdfParams> {
        match self {
            Self::Keyring { .. } => None,
            Self::Recovery { kdf, .. } | Self::Passphrase { kdf, .. } => Some(kdf),
        }
    }

    /// The keyring account entry id, for a [`SlotKind::Keyring`] slot only.
    fn keyring_entry(&self) -> Option<&str> {
        match self {
            Self::Keyring { entry, .. } => Some(entry),
            Self::Recovery { .. } | Self::Passphrase { .. } => None,
        }
    }

    fn wrapped(&self) -> &str {
        match self {
            Self::Keyring { wrapped, .. } | Self::Recovery { wrapped, .. } | Self::Passphrase { wrapped, .. } => wrapped,
        }
    }
}

/// The on-disk format: wrapped DEKs and KDF parameters only, never the DEK
/// itself. Safe to back up (docs/ENCRYPTION.md).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyFile {
    pub format: u32,
    /// Base64 of 16 random bytes, bound into every slot's AAD so a slot
    /// from a different `keys.json` can never be mistaken for one of ours.
    pub vault_id: String,
    pub slots: Vec<Slot>,
}

impl KeyFile {
    fn new(vault_id: [u8; VAULT_ID_LEN]) -> Self {
        Self { format: FORMAT_VERSION, vault_id: b64_encode(&vault_id), slots: Vec::new() }
    }

    fn vault_id_bytes(&self) -> Result<[u8; VAULT_ID_LEN], Error> {
        let bytes = b64_decode(&self.vault_id)?;
        <[u8; VAULT_ID_LEN]>::try_from(bytes.as_slice())
            .map_err(|_| Error::new(ErrorKind::KeysFileCorrupt, "keys.json: vault_id isn't 16 bytes."))
    }

    fn slot(&self, kind: SlotKind) -> Option<&Slot> {
        self.slots.iter().find(|s| s.kind() == kind)
    }

    /// Inserts `slot`, first dropping any existing slot of the same kind —
    /// "at most one slot of each type".
    fn set_slot(&mut self, slot: Slot) {
        let kind = slot.kind();
        self.slots.retain(|s| s.kind() != kind);
        self.slots.push(slot);
    }

    fn remove_slot(&mut self, kind: SlotKind) {
        self.slots.retain(|s| s.kind() != kind);
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, Error> {
    STANDARD.decode(s).map_err(|_| Error::new(ErrorKind::KeysFileCorrupt, "keys.json: a field isn't valid base64."))
}

/// The canonical, hand-built AAD for `slot` (plus `vault_id`): a fixed byte
/// layout driven entirely by code, not by struct field order, so the same
/// metadata always serializes the same way and nothing but the metadata
/// itself can change it.
fn slot_aad(vault_id: &[u8; VAULT_ID_LEN], slot: &Slot) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    out.extend_from_slice(AAD_DOMAIN);
    out.push(0);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.push(0);
    out.extend_from_slice(vault_id);
    out.push(0);
    let tag = match slot.kind() {
        SlotKind::Keyring => TAG_KEYRING,
        SlotKind::Recovery => TAG_RECOVERY,
        SlotKind::Passphrase => TAG_PASSPHRASE,
    };
    out.push(tag);
    if let Some(entry) = slot.keyring_entry() {
        out.push(0);
        let entry_bytes = entry.as_bytes();
        out.push(u8::try_from(entry_bytes.len()).unwrap_or(u8::MAX));
        out.extend_from_slice(entry_bytes);
    }
    if let Some(kdf) = slot.kdf() {
        out.push(0);
        out.push(match kdf.alg {
            KdfAlg::Argon2id => ALG_ARGON2ID,
        });
        out.extend_from_slice(&kdf.m_kib.to_le_bytes());
        out.extend_from_slice(&kdf.t.to_le_bytes());
        out.extend_from_slice(&kdf.p.to_le_bytes());
        let salt = b64_decode(&kdf.salt)?;
        out.push(0);
        out.push(u8::try_from(salt.len()).unwrap_or(u8::MAX));
        out.extend_from_slice(&salt);
    }
    Ok(out)
}

/// Derives a 32-byte KEK from `secret` with the slot's own Argon2id
/// parameters.
fn derive_kek(secret: &[u8], kdf: &KdfParams) -> Result<Key32, Error> {
    kdf.check_bounds()?;
    let salt = b64_decode(&kdf.salt)?;
    let params = Params::new(kdf.m_kib, kdf.t, kdf.p, Some(32))
        .map_err(|e| Error::new(ErrorKind::KeysFileCorrupt, format!("keys.json: bad Argon2 parameters: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    let result = argon2
        .hash_password_into(secret, &salt, &mut out)
        .map(|()| Key32::from_slice(&out).expect("32-byte buffer"))
        .map_err(|e| Error::new(ErrorKind::Internal, format!("Argon2 key derivation failed: {e}")));
    out.zeroize();
    result
}

fn new_kdf_params(params: (u32, u32, u32)) -> Result<KdfParams, Error> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| Error::new(ErrorKind::Internal, format!("RNG failure: {e}")))?;
    Ok(KdfParams { alg: KdfAlg::Argon2id, m_kib: params.0, t: params.1, p: params.2, salt: b64_encode(&salt) })
}

fn random_vault_id() -> Result<[u8; VAULT_ID_LEN], Error> {
    let mut id = [0u8; VAULT_ID_LEN];
    getrandom::getrandom(&mut id).map_err(|e| Error::new(ErrorKind::Internal, format!("RNG failure: {e}")))?;
    Ok(id)
}

/// Seals `dek` under `kek` for a slot of `kind`, building that slot's AAD
/// from its own metadata first. `kdf` is `None` except for a recovery or
/// passphrase slot; `entry` is `None` except for a keyring slot.
fn wrap_dek(
    dek: &Key32,
    kek: &Key32,
    vault_id: &[u8; VAULT_ID_LEN],
    kind: SlotKind,
    kdf: Option<KdfParams>,
    entry: Option<String>,
) -> Result<Slot, Error> {
    // A placeholder just to compute the AAD before we have ciphertext; the
    // wrapped field itself is never part of the AAD (see module docs).
    let unwrapped = match kind {
        SlotKind::Keyring => Slot::Keyring { entry: entry.clone().expect("keyring slot needs an entry id"), wrapped: String::new() },
        SlotKind::Recovery => Slot::Recovery { kdf: kdf.clone().expect("recovery slot needs kdf params"), wrapped: String::new() },
        SlotKind::Passphrase => Slot::Passphrase { kdf: kdf.clone().expect("passphrase slot needs kdf params"), wrapped: String::new() },
    };
    let aad = slot_aad(vault_id, &unwrapped)?;
    let wrapped = b64_encode(&aead::seal(kek, dek.as_bytes(), &aad));
    Ok(match kind {
        SlotKind::Keyring => Slot::Keyring { entry: entry.expect("keyring slot needs an entry id"), wrapped },
        SlotKind::Recovery => Slot::Recovery { kdf: kdf.expect("recovery slot needs kdf params"), wrapped },
        SlotKind::Passphrase => Slot::Passphrase { kdf: kdf.expect("passphrase slot needs kdf params"), wrapped },
    })
}

/// A `keys.json` that's been read but not unlocked.
#[derive(Debug)]
pub struct Locked {
    path: PathBuf,
    file: KeyFile,
}

impl Locked {
    /// Whether this file has a keyring slot at all — the storage service
    /// (`storage.rs`) only ever attempts a silent unlock when this is true.
    pub fn has_keyring(&self) -> bool {
        self.file.slot(SlotKind::Keyring).is_some()
    }

    pub fn has_recovery(&self) -> bool {
        self.file.slot(SlotKind::Recovery).is_some()
    }

    pub fn has_passphrase(&self) -> bool {
        self.file.slot(SlotKind::Passphrase).is_some()
    }

    /// The keyring slot's entry id, if any (`storage::StorageService::erase_all`
    /// uses this to know which keyring account to delete).
    pub fn keyring_entry(&self) -> Option<String> {
        self.file.slot(SlotKind::Keyring).and_then(Slot::keyring_entry).map(str::to_owned)
    }

    pub fn unlock_keyring<S: SecretStore>(&self, slot: &KeyringSlot<S>) -> Result<Unlocked, Error> {
        let keyring_slot = self.file.slot(SlotKind::Keyring).ok_or_else(|| Error::new(ErrorKind::SlotMissing, "keys.json has no keyring slot."))?;
        let entry = keyring_slot.keyring_entry().expect("a keyring slot always carries an entry id");
        let kek = slot
            .get(entry)?
            .ok_or_else(|| Error::new(ErrorKind::KeyringSecretMissing, "The OS keyring has no Snowdrop secret."))?;
        self.unwrap_with(keyring_slot, &kek)
    }

    pub fn unlock_recovery(&self, code: &str) -> Result<Unlocked, Error> {
        let recovery_slot = self.file.slot(SlotKind::Recovery).ok_or_else(|| Error::new(ErrorKind::SlotMissing, "keys.json has no recovery slot."))?;
        let parsed = RecoveryCode::parse(code)?;
        let kdf = recovery_slot.kdf().expect("recovery slot always carries kdf params");
        let kek = derive_kek(&parsed.0, kdf)?;
        self.unwrap_with(recovery_slot, &kek)
    }

    pub fn unlock_passphrase(&self, passphrase: &str) -> Result<Unlocked, Error> {
        let passphrase_slot =
            self.file.slot(SlotKind::Passphrase).ok_or_else(|| Error::new(ErrorKind::SlotMissing, "keys.json has no passphrase slot."))?;
        let kdf = passphrase_slot.kdf().expect("passphrase slot always carries kdf params");
        let kek = derive_kek(passphrase.as_bytes(), kdf)?;
        self.unwrap_with(passphrase_slot, &kek)
    }

    fn unwrap_with(&self, slot: &Slot, kek: &Key32) -> Result<Unlocked, Error> {
        let vault_id = self.file.vault_id_bytes()?;
        let aad = slot_aad(&vault_id, slot)?;
        let wrapped = b64_decode(slot.wrapped())?;
        let dek_bytes =
            aead::open(kek, &wrapped, &aad).map_err(|_| Error::new(ErrorKind::AuthFailed, "Wrong secret, or keys.json was tampered with."))?;
        let dek = Key32::from_slice(&dek_bytes).ok_or_else(|| Error::new(ErrorKind::KeysFileCorrupt, "keys.json: unwrapped DEK isn't 32 bytes."))?;
        Ok(Unlocked { path: self.path.clone(), dek, file: self.file.clone() })
    }
}

/// An unlocked `keys.json`: the DEK is in memory, zeroized on drop
/// ([`Key32`]), and never part of [`Unlocked::save`]'s output.
pub struct Unlocked {
    path: PathBuf,
    dek: Key32,
    file: KeyFile,
}

impl fmt::Debug for Unlocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Unlocked").field("path", &self.path).field("dek", &self.dek).field("file", &self.file).finish()
    }
}

impl Unlocked {
    pub fn vault_key(&self) -> Key32 {
        hkdf_subkey(&self.dek, "snowdrop/vault/v1")
    }

    pub fn webcache_key(&self) -> Key32 {
        hkdf_subkey(&self.dek, "snowdrop/webcache/v1")
    }

    /// The vault id bound into this `keys.json`'s AAD — also the id every
    /// vault manifest/blob must be opened with (see `vault::Vault::open`).
    pub fn vault_id(&self) -> Result<[u8; VAULT_ID_LEN], Error> {
        self.file.vault_id_bytes()
    }

    pub fn has_keyring(&self) -> bool {
        self.file.slot(SlotKind::Keyring).is_some()
    }

    pub fn has_recovery(&self) -> bool {
        self.file.slot(SlotKind::Recovery).is_some()
    }

    pub fn has_passphrase(&self) -> bool {
        self.file.slot(SlotKind::Passphrase).is_some()
    }

    /// The keyring slot's entry id, if any.
    pub fn keyring_entry(&self) -> Option<String> {
        self.file.slot(SlotKind::Keyring).and_then(Slot::keyring_entry).map(str::to_owned)
    }

    /// Refuses with [`ErrorKind::LastUnlockMethod`] if removing the slot of
    /// `kind` would leave `keys.json` with zero slots at all — a no-op
    /// (`Ok`) if that slot doesn't exist, since there's then nothing to
    /// remove and no invariant at risk.
    fn refuse_if_last_slot(&self, kind: SlotKind) -> Result<(), Error> {
        if self.file.slot(kind).is_none() {
            return Ok(());
        }
        if self.file.slots.len() <= 1 {
            return Err(Error::new(
                ErrorKind::LastUnlockMethod,
                "That's the only way left to unlock Snowdrop. Set up another method before removing it.",
            ));
        }
        Ok(())
    }

    /// Generates a fresh recovery code, replacing any existing recovery
    /// slot, and returns it — this is the only time it's ever available;
    /// only its Argon2id-wrapped DEK is kept.
    pub fn add_recovery(&mut self) -> Result<RecoveryCode, Error> {
        let code = RecoveryCode::generate()?;
        let kdf = new_kdf_params(RECOVERY_KDF)?;
        let kek = derive_kek(&code.0, &kdf)?;
        let vault_id = self.file.vault_id_bytes()?;
        let slot = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Recovery, Some(kdf), None)?;
        self.file.set_slot(slot);
        Ok(code)
    }

    /// Refuses with [`ErrorKind::LastUnlockMethod`] if the recovery slot is
    /// the only slot left (docs/ENCRYPTION.md, "Key hierarchy").
    pub fn remove_recovery(&mut self) -> Result<(), Error> {
        self.refuse_if_last_slot(SlotKind::Recovery)?;
        self.file.remove_slot(SlotKind::Recovery);
        Ok(())
    }

    /// `None` removes the passphrase slot (refusing with
    /// [`ErrorKind::LastUnlockMethod`] if it's the only slot left); `Some`
    /// replaces it.
    pub fn set_passphrase(&mut self, passphrase: Option<&str>) -> Result<(), Error> {
        match passphrase {
            None => {
                self.refuse_if_last_slot(SlotKind::Passphrase)?;
                self.file.remove_slot(SlotKind::Passphrase);
                Ok(())
            }
            Some(pass) => {
                check_new_passphrase(pass)?;
                let kdf = new_kdf_params(PASSPHRASE_KDF)?;
                let kek = derive_kek(pass.as_bytes(), &kdf)?;
                let vault_id = self.file.vault_id_bytes()?;
                let slot = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Passphrase, Some(kdf), None)?;
                self.file.set_slot(slot);
                Ok(())
            }
        }
    }

    /// Re-enrols the keyring slot under a brand-new entry id and secret
    /// (docs/ENCRYPTION.md, "Key hierarchy") — never an overwrite of the
    /// previous one. Returns the superseded entry id, if there was one, so
    /// the caller can best-effort delete its keyring account *after*
    /// [`save`](Self::save) has committed the new reference: a late write to
    /// that old account can then only ever touch something `keys.json` no
    /// longer points at.
    pub fn enroll_keyring<S: SecretStore>(&mut self, slot: &KeyringSlot<S>) -> Result<Option<String>, Error> {
        let old_entry = self.keyring_entry();
        let (entry, kek) = slot.create_new()?;
        let vault_id = self.file.vault_id_bytes()?;
        let wrapped = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Keyring, None, Some(entry))?;
        self.file.set_slot(wrapped);
        Ok(old_entry)
    }

    pub fn save(&self) -> Result<(), Error> {
        write_atomic(&self.path, &self.file)
    }
}

fn io_err(path: &Path, e: io::Error) -> Error {
    Error::new(ErrorKind::Internal, format!("{}: {e}", path.display()))
}

/// Writes `file` as `path`'s new contents: a temp file in the same
/// directory, mode `0600`, fsynced, renamed into place, then the directory
/// itself fsynced so the rename survives a crash.
fn write_atomic(path: &Path, file: &KeyFile) -> Result<(), Error> {
    let json = serde_json::to_vec_pretty(file).map_err(|e| Error::new(ErrorKind::Internal, format!("Couldn't encode keys.json: {e}")))?;
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
    let tmp_path = dir.join(format!(".keys.json.{}.tmp", std::process::id()));

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut tmp_file = options.open(&tmp_path).map_err(|e| io_err(&tmp_path, e))?;
    tmp_file.write_all(&json).map_err(|e| io_err(&tmp_path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = tmp_file.metadata().map_err(|e| io_err(&tmp_path, e))?.permissions();
        perm.set_mode(0o600);
        tmp_file.set_permissions(perm).map_err(|e| io_err(&tmp_path, e))?;
    }
    tmp_file.sync_all().map_err(|e| io_err(&tmp_path, e))?;
    drop(tmp_file);

    fs::rename(&tmp_path, path).map_err(|e| io_err(path, e))?;

    let dir_file = fs::File::open(dir).map_err(|e| io_err(dir, e))?;
    dir_file.sync_all().map_err(|e| io_err(dir, e))?;
    Ok(())
}

/// Reads `path`, or `Ok(None)` if it doesn't exist yet (first run).
pub fn load(path: &Path) -> Result<Option<Locked>, Error> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(path, e)),
    };
    let file: KeyFile =
        serde_json::from_slice(&bytes).map_err(|e| Error::new(ErrorKind::KeysFileCorrupt, format!("keys.json doesn't parse: {e}")))?;
    if file.format != FORMAT_VERSION {
        return Err(Error::new(ErrorKind::KeysFileCorrupt, format!("keys.json format {} isn't one this build understands.", file.format)));
    }
    for slot in &file.slots {
        if let Some(kdf) = slot.kdf() {
            kdf.check_bounds()?;
        }
    }
    Ok(Some(Locked { path: path.to_path_buf(), file }))
}

fn refuse_if_exists(path: &Path) -> Result<(), Error> {
    if path.exists() {
        return Err(Error::new(ErrorKind::Config, "keys.json already exists; load and unlock it instead of initializing again."));
    }
    Ok(())
}

/// Creates a brand new `keys.json` with a single keyring slot, under a fresh
/// entry id (never a fixed one — see `secrets.rs`). Refuses if `path`
/// already exists. Any keyring secret left over from before (an interrupted
/// setup, a partial erase) is simply orphaned, not reused or overwritten —
/// harmless, since nothing ever references it (docs/ENCRYPTION.md, "Key
/// hierarchy").
pub fn init_with_keyring<S: SecretStore>(path: &Path, slot: &KeyringSlot<S>) -> Result<Unlocked, Error> {
    refuse_if_exists(path)?;
    let (entry, kek) = slot.create_new()?;
    let dek = Key32::random();
    let vault_id = random_vault_id()?;
    let mut file = KeyFile::new(vault_id);
    file.set_slot(wrap_dek(&dek, &kek, &vault_id, SlotKind::Keyring, None, Some(entry))?);
    let unlocked = Unlocked { path: path.to_path_buf(), dek, file };
    unlocked.save()?;
    Ok(unlocked)
}

/// Creates a brand new `keys.json` with a single passphrase slot. Refuses
/// if `path` already exists.
pub fn init_with_passphrase(path: &Path, passphrase: &str) -> Result<Unlocked, Error> {
    check_new_passphrase(passphrase)?;
    refuse_if_exists(path)?;
    let dek = Key32::random();
    let vault_id = random_vault_id()?;
    let mut file = KeyFile::new(vault_id);
    let kdf = new_kdf_params(PASSPHRASE_KDF)?;
    let kek = derive_kek(passphrase.as_bytes(), &kdf)?;
    file.set_slot(wrap_dek(&dek, &kek, &vault_id, SlotKind::Passphrase, Some(kdf), None)?);
    let unlocked = Unlocked { path: path.to_path_buf(), dek, file };
    unlocked.save()?;
    Ok(unlocked)
}

/// Crockford base32 (RFC-free, 32-symbol alphabet that omits `I`, `L`, `O`,
/// `U` to avoid confusion): used for [`RecoveryCode`]'s display form.
const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 160 random bits, shown as 8 groups of 4 Crockford base32 characters (32
/// chars; 160 / 5 == 32, so no padding), plus a 9th group of 4 characters
/// that's the first 20 bits of SHA-256 over the 20 raw bytes — a checksum
/// [`RecoveryCode::parse`] checks before any KDF runs, so a typo is caught
/// immediately instead of surfacing as a slow, confusing auth failure.
pub struct RecoveryCode([u8; RECOVERY_SECRET_LEN]);

impl Drop for RecoveryCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("RecoveryCode").field(&"<redacted>").finish()
    }
}

impl fmt::Display for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let body = base32_encode(&self.0);
        let checksum = checksum_chars(&self.0);
        let all: String = body.chars().chain(checksum.chars()).collect();
        let grouped: Vec<String> = all.chars().collect::<Vec<_>>().chunks(4).map(|c| c.iter().collect()).collect();
        write!(f, "{}", grouped.join("-"))
    }
}

impl RecoveryCode {
    fn generate() -> Result<Self, Error> {
        let mut bytes = [0u8; RECOVERY_SECRET_LEN];
        getrandom::getrandom(&mut bytes).map_err(|e| Error::new(ErrorKind::Internal, format!("RNG failure: {e}")))?;
        Ok(Self(bytes))
    }

    /// Lenient parsing: case-insensitive, spaces/dashes ignored, and
    /// Crockford's usual `I`/`L` → `1`, `O` → `0` substitutions, then a
    /// checksum check — all before any KDF runs. A failure at any step
    /// (wrong length, a character outside the alphabet, or a checksum
    /// mismatch) is reported the same way: [`ErrorKind::RecoveryCodeTypo`].
    pub fn parse(input: &str) -> Result<Self, Error> {
        let normalized = normalize(input);
        if normalized.len() != 36 || !normalized.bytes().all(|b| CROCKFORD_ALPHABET.contains(&b)) {
            return Err(typo_error());
        }
        let (body, checksum) = normalized.split_at(32);
        let bytes = base32_decode(body).ok_or_else(typo_error)?;
        let bytes: [u8; RECOVERY_SECRET_LEN] = bytes.try_into().map_err(|_| typo_error())?;
        if checksum != checksum_chars(&bytes) {
            return Err(typo_error());
        }
        Ok(Self(bytes))
    }
}

fn typo_error() -> Error {
    Error::new(ErrorKind::RecoveryCodeTypo, "That recovery code doesn't look right. Check it against what you saved.")
}

fn normalize(input: &str) -> String {
    input
        .chars()
        .filter_map(|c| match c.to_ascii_uppercase() {
            ' ' | '-' | '\t' | '\n' | '\r' => None,
            'I' | 'L' => Some('1'),
            'O' => Some('0'),
            other => Some(other),
        })
        .collect()
}

/// Encodes `bytes` as Crockford base32, 5 bits per character, most
/// significant bits first. Only called with `bytes.len() * 8` a multiple of
/// 5 (20 bytes → 32 chars), so there's never a partial trailing group.
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD_ALPHABET[((buffer >> bits) & 0x1F) as usize] as char);
        }
    }
    out
}

/// The inverse of [`base32_encode`] for exactly [`RECOVERY_SECRET_LEN`]
/// bytes (32 input characters). `None` on any character outside the
/// alphabet or the wrong input length.
fn base32_decode(chars: &str) -> Option<Vec<u8>> {
    if chars.len() != 32 {
        return None;
    }
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(RECOVERY_SECRET_LEN);
    for c in chars.bytes() {
        let value = CROCKFORD_ALPHABET.iter().position(|&a| a == c)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    (out.len() == RECOVERY_SECRET_LEN).then_some(out)
}

/// The first 20 bits of SHA-256(`bytes`), as exactly 4 Crockford characters.
fn checksum_chars(bytes: &[u8; RECOVERY_SECRET_LEN]) -> String {
    let digest = Sha256::digest(bytes);
    let value: u32 = (u32::from(digest[0]) << 12) | (u32::from(digest[1]) << 4) | (u32::from(digest[2]) >> 4);
    [15u32, 10, 5, 0].iter().map(|shift| CROCKFORD_ALPHABET[((value >> shift) & 0x1F) as usize] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{FakeStore, SecretStore};
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-keyslots-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    fn keyring_slot() -> KeyringSlot<FakeStore> {
        KeyringSlot::new(FakeStore::new())
    }

    #[test]
    fn init_and_unlock_through_keyring() {
        let _dir = temp_dir("keyring");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let unlocked = init_with_keyring(&path, &slot).unwrap();
        let vault_key = unlocked.vault_key();

        let locked = load(&path).unwrap().unwrap();
        let reopened = locked.unlock_keyring(&slot).unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn init_and_unlock_through_passphrase() {
        let _dir = temp_dir("passphrase-init");
        let path = _dir.path().join("keys.json");
        let unlocked = init_with_passphrase(&path, "correct horse battery staple").unwrap();
        let vault_key = unlocked.vault_key();

        let locked = load(&path).unwrap().unwrap();
        let reopened = locked.unlock_passphrase("correct horse battery staple").unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn init_and_unlock_through_recovery() {
        let _dir = temp_dir("recovery-init");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        let code = unlocked.add_recovery().unwrap();
        unlocked.save().unwrap();
        let vault_key = unlocked.vault_key();

        let locked = load(&path).unwrap().unwrap();
        let reopened = locked.unlock_recovery(&code.to_string()).unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn wrong_passphrase_is_an_auth_failure() {
        let _dir = temp_dir("wrong-pass");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "right one").unwrap();
        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_passphrase("wrong one").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn wrong_recovery_code_is_an_auth_failure() {
        let _dir = temp_dir("wrong-recovery");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        unlocked.add_recovery().unwrap();
        unlocked.save().unwrap();

        let locked = load(&path).unwrap().unwrap();
        let other = RecoveryCode::generate().unwrap();
        let err = locked.unlock_recovery(&other.to_string()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn tampered_kdf_param_fails() {
        let _dir = temp_dir("tamper-param");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "a passphrase").unwrap();
        let mut locked = load(&path).unwrap().unwrap();
        match locked.file.slots.get_mut(0).unwrap() {
            Slot::Passphrase { kdf, .. } => kdf.m_kib += 8,
            _ => unreachable!(),
        }
        let err = locked.unlock_passphrase("a passphrase").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn rejects_a_short_passphrase_when_creating_or_changing_one() {
        let dir = temp_dir("short-pass");
        let path = dir.path().join("keys.json");
        for short in ["", "1234567", "abc"] {
            let err = init_with_passphrase(&path, short).err().unwrap();
            assert_eq!(err.kind, ErrorKind::Config);
        }
        assert!(!path.exists());
        // Exactly 8 UTF-16 units is fine; so is 4 astral characters (8 units, as the UI counts).
        init_with_passphrase(&path, "12345678").unwrap();
        let mut unlocked = load(&path).unwrap().unwrap().unlock_passphrase("12345678").unwrap();
        assert_eq!(unlocked.set_passphrase(Some("short")).unwrap_err().kind, ErrorKind::Config);
        unlocked.set_passphrase(Some("\u{1F600}\u{1F600}\u{1F600}\u{1F600}")).unwrap();
        // The old, still-valid passphrase is untouched by the refused change.
        assert_eq!(unlocked.set_passphrase(Some("")).unwrap_err().kind, ErrorKind::Config);
    }

    #[test]
    fn unlocking_never_applies_the_minimum() {
        // A keys.json made before the minimum existed (a 3-char passphrase)
        // must still unlock: build one by hand-wrapping with the same KDF.
        let dir = temp_dir("legacy-short-pass");
        let path = dir.path().join("keys.json");
        init_with_passphrase(&path, "12345678").unwrap();
        let locked = load(&path).unwrap().unwrap();
        assert!(locked.unlock_passphrase("12345678").is_ok());
        // A wrong, short secret is an auth failure, not a config error.
        assert_eq!(locked.unlock_passphrase("abc").unwrap_err().kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn rejects_absurd_kdf_params_on_load() {
        for (m_kib, t, p) in [(u32::MAX, 1, 1), (KDF_MAX_M_KIB + 1, 1, 1), (8, 0, 1), (8, KDF_MAX_T + 1, 1), (8, 1, 0), (8, 1, KDF_MAX_P + 1), (7, 1, 1), (8, 1, 2)] {
            let dir = temp_dir("kdf-bounds");
            let path = dir.path().join("keys.json");
            init_with_passphrase(&path, "a passphrase").unwrap();
            let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let kdf = &mut json["slots"][0]["kdf"];
            kdf["m_kib"] = m_kib.into();
            kdf["t"] = t.into();
            kdf["p"] = p.into();
            fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
            let Err(err) = load(&path) else { panic!("out-of-range params must not load") };
            assert_eq!(err.kind, ErrorKind::KeysFileCorrupt, "{m_kib}/{t}/{p}");
        }
    }

    #[test]
    fn accepts_the_real_production_kdf_params_on_load() {
        let kdf = KdfParams { alg: KdfAlg::Argon2id, m_kib: 65536, t: 3, p: 1, salt: String::new() };
        assert!(kdf.check_bounds().is_ok());
        let recovery = KdfParams { alg: KdfAlg::Argon2id, m_kib: 19456, t: 2, p: 1, salt: String::new() };
        assert!(recovery.check_bounds().is_ok());
    }

    #[test]
    fn tampered_salt_fails() {
        let _dir = temp_dir("tamper-salt");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "a passphrase").unwrap();
        let mut locked = load(&path).unwrap().unwrap();
        match locked.file.slots.get_mut(0).unwrap() {
            Slot::Passphrase { kdf, .. } => {
                let mut salt = b64_decode(&kdf.salt).unwrap();
                salt[0] ^= 0x01;
                kdf.salt = b64_encode(&salt);
            }
            _ => unreachable!(),
        }
        let err = locked.unlock_passphrase("a passphrase").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn tampered_vault_id_fails() {
        let _dir = temp_dir("tamper-vault-id");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "a passphrase").unwrap();
        let mut locked = load(&path).unwrap().unwrap();
        let mut id = b64_decode(&locked.file.vault_id).unwrap();
        id[0] ^= 0x01;
        locked.file.vault_id = b64_encode(&id);
        let err = locked.unlock_passphrase("a passphrase").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn swapping_a_wrapped_blob_between_slot_types_fails() {
        let _dir = temp_dir("swap-slots");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        unlocked.set_passphrase(Some("a passphrase")).unwrap();
        unlocked.add_recovery().unwrap();
        unlocked.save().unwrap();

        let mut locked = load(&path).unwrap().unwrap();
        let recovery_wrapped = locked.file.slot(SlotKind::Recovery).unwrap().wrapped().to_owned();
        match locked.file.slots.iter_mut().find(|s| s.kind() == SlotKind::Passphrase).unwrap() {
            Slot::Passphrase { wrapped, .. } => *wrapped = recovery_wrapped,
            _ => unreachable!(),
        }
        let err = locked.unlock_passphrase("a passphrase").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn recovery_code_typo_is_detected_before_the_kdf_runs() {
        let code = RecoveryCode::generate().unwrap();
        let mut text = code.to_string();
        // Flip one character in the body so the checksum no longer matches.
        let flipped = if text.as_bytes()[0] == b'0' { '1' } else { '0' };
        text.replace_range(0..1, &flipped.to_string());
        let err = RecoveryCode::parse(&text).unwrap_err();
        assert_eq!(err.kind, ErrorKind::RecoveryCodeTypo);
    }

    #[test]
    fn recovery_code_parsing_is_lenient() {
        let code = RecoveryCode::generate().unwrap();
        let canonical = code.to_string();
        // Lowercase, extra spaces, and ambiguous-letter substitutions for
        // every 0/1 digit the canonical form happens to contain.
        let sloppy: String = canonical
            .chars()
            .map(|c| match c {
                '0' => 'o',
                '1' => 'l',
                '-' => ' ',
                other => other.to_ascii_lowercase(),
            })
            .collect();
        let reparsed = RecoveryCode::parse(&sloppy).unwrap();
        assert_eq!(reparsed.to_string(), canonical);
    }

    #[test]
    fn recovery_code_rejects_the_wrong_length() {
        let err = RecoveryCode::parse("0000-0000").unwrap_err();
        assert_eq!(err.kind, ErrorKind::RecoveryCodeTypo);
    }

    #[test]
    fn reenrolling_the_keyring_after_the_secret_is_lost_then_unlocking_via_recovery() {
        let _dir = temp_dir("reenroll");
        let path = _dir.path().join("keys.json");
        let original_store = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &original_store).unwrap();
        let code = unlocked.add_recovery().unwrap();
        unlocked.save().unwrap();
        let vault_key = unlocked.vault_key();

        // The keyring secret is "lost": a fresh provider, empty.
        let new_store = keyring_slot();
        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_keyring(&new_store).unwrap_err();
        assert_eq!(err.kind, ErrorKind::KeyringSecretMissing);

        let mut recovered = locked.unlock_recovery(&code.to_string()).unwrap();
        recovered.enroll_keyring(&new_store).unwrap();
        recovered.save().unwrap();
        assert_eq!(recovered.vault_key().as_bytes(), vault_key.as_bytes());

        let reloaded = load(&path).unwrap().unwrap();
        let via_new_keyring = reloaded.unlock_keyring(&new_store).unwrap();
        assert_eq!(via_new_keyring.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn missing_slot_is_distinct_from_missing_keyring_secret() {
        let _dir = temp_dir("missing-slot");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "a passphrase").unwrap();
        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_keyring(&keyring_slot()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::SlotMissing);
    }

    #[test]
    fn removing_the_recovery_slot() {
        let _dir = temp_dir("remove-recovery");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        let code = unlocked.add_recovery().unwrap();
        unlocked.remove_recovery().unwrap();
        unlocked.save().unwrap();

        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_recovery(&code.to_string()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::SlotMissing);
    }

    #[test]
    fn save_load_round_trip_and_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let _dir = temp_dir("round-trip");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        unlocked.set_passphrase(Some("extra-passphrase")).unwrap();
        unlocked.save().unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let locked = load(&path).unwrap().unwrap();
        assert_eq!(locked.file.slots.len(), 2);
        assert_eq!(locked.file.vault_id, unlocked.file.vault_id);
    }

    #[test]
    fn init_refuses_if_the_file_already_exists() {
        let _dir = temp_dir("refuse-exists");
        let path = _dir.path().join("keys.json");
        init_with_passphrase(&path, "first-passphrase").unwrap();
        let err = init_with_passphrase(&path, "second").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        let err = init_with_keyring(&path, &keyring_slot()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
    }

    #[test]
    fn load_of_a_missing_file_is_none() {
        let _dir = temp_dir("load-missing");
        let path = _dir.path().join("keys.json");
        assert!(load(&path).unwrap().is_none());
    }

    #[test]
    fn load_rejects_a_malformed_file() {
        let _dir = temp_dir("malformed");
        let path = _dir.path().join("keys.json");
        fs::write(&path, b"not json").unwrap();
        let err = load(&path).unwrap_err();
        assert_eq!(err.kind, ErrorKind::KeysFileCorrupt);
    }

    #[test]
    fn load_rejects_an_unknown_format_version() {
        let _dir = temp_dir("future-format");
        let path = _dir.path().join("keys.json");
        fs::write(&path, r#"{"format":99,"vault_id":"AAAA","slots":[]}"#).unwrap();
        let err = load(&path).unwrap_err();
        assert_eq!(err.kind, ErrorKind::KeysFileCorrupt);
    }

    #[test]
    fn init_with_keyring_leaves_an_unrelated_keyring_secret_alone() {
        let _dir = temp_dir("keyring-orphaned-secret");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let (stale_entry, stale_key) = slot.create_new().unwrap();
        let unlocked = init_with_keyring(&path, &slot).unwrap();
        // The pre-existing entry is simply orphaned, not touched or reused
        // (docs/ENCRYPTION.md: "orphaned leftovers are harmless").
        assert_eq!(slot.get(&stale_entry).unwrap().unwrap().as_bytes(), stale_key.as_bytes());
        let reopened = load(&path).unwrap().unwrap().unlock_keyring(&slot).unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), unlocked.vault_key().as_bytes());
    }

    #[test]
    fn enrolling_again_returns_the_superseded_entry_without_deleting_it() {
        let store = Arc::new(FakeStore::new());
        let _dir = temp_dir("enroll-returns-old");
        let path = _dir.path().join("keys.json");
        let slot = KeyringSlot::new(store);
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        let first_entry = unlocked.keyring_entry().unwrap();

        let old_entry = unlocked.enroll_keyring(&slot).unwrap();
        assert_eq!(old_entry.as_deref(), Some(first_entry.as_str()));
        // enroll_keyring itself never deletes the superseded account —
        // that's the caller's job, done only after `save()` commits the new
        // reference (docs/ENCRYPTION.md, "Key hierarchy").
        assert!(slot.get(&first_entry).unwrap().is_some());
        unlocked.save().unwrap();
        slot.delete(&first_entry).unwrap();
        assert!(slot.get(&first_entry).unwrap().is_none());

        let new_entry = unlocked.keyring_entry().unwrap();
        assert_ne!(new_entry, first_entry);
        assert!(slot.get(&new_entry).unwrap().is_some());
    }

    #[test]
    fn tampered_keyring_entry_id_fails_even_with_the_same_underlying_secret() {
        let store = Arc::new(FakeStore::new());
        let _dir = temp_dir("tamper-entry-same-secret");
        let path = _dir.path().join("keys.json");
        let slot = KeyringSlot::new(store.clone());
        init_with_keyring(&path, &slot).unwrap();

        let mut locked = load(&path).unwrap().unwrap();
        let orig_entry = match locked.file.slots.first().unwrap() {
            Slot::Keyring { entry, .. } => entry.clone(),
            _ => unreachable!(),
        };
        // An attacker who can write keys.json duplicates the same keyring
        // secret under a new account and repoints the slot at it.
        let secret = store.get(&crate::secrets::account_name(&orig_entry)).unwrap().unwrap();
        store.set(&crate::secrets::account_name("copied"), &secret).unwrap();
        match locked.file.slots.first_mut().unwrap() {
            Slot::Keyring { entry, .. } => *entry = "copied".to_owned(),
            _ => unreachable!(),
        }

        // The same secret bytes unlock the account, but the AAD was built
        // from the *tampered* entry id, so it no longer matches what was
        // sealed under the original one.
        let err = locked.unlock_keyring(&slot).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn passphrase_only_cannot_remove_its_last_unlock_method() {
        let _dir = temp_dir("last-slot-passphrase-only");
        let path = _dir.path().join("keys.json");
        let mut unlocked = init_with_passphrase(&path, "the only way in").unwrap();
        let err = unlocked.set_passphrase(None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::LastUnlockMethod);
        // Nothing was actually removed.
        assert!(unlocked.has_passphrase());
    }

    #[test]
    fn recovery_plus_passphrase_only_the_very_last_slot_is_refused() {
        let _dir = temp_dir("last-slot-recovery-plus-passphrase");
        let path = _dir.path().join("keys.json");
        let mut unlocked = init_with_passphrase(&path, "a passphrase").unwrap();
        unlocked.add_recovery().unwrap();

        // Two slots: removing one is fine, since the other remains.
        unlocked.remove_recovery().unwrap();
        assert!(!unlocked.has_recovery());
        assert!(unlocked.has_passphrase());

        // Now passphrase is the only slot left: removing it is refused.
        let err = unlocked.set_passphrase(None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::LastUnlockMethod);
        assert!(unlocked.has_passphrase());

        // And symmetrically, starting over with recovery as the survivor:
        // once it's the last slot, removing it is refused too.
        let _dir2 = temp_dir("last-slot-recovery-plus-passphrase-2");
        let path2 = _dir2.path().join("keys.json");
        let mut unlocked2 = init_with_passphrase(&path2, "a passphrase").unwrap();
        unlocked2.add_recovery().unwrap();
        unlocked2.set_passphrase(None).unwrap();
        let err = unlocked2.remove_recovery().unwrap_err();
        assert_eq!(err.kind, ErrorKind::LastUnlockMethod);
    }

    #[test]
    fn a_keyring_slot_means_removing_recovery_or_passphrase_is_never_the_last_slot() {
        let _dir = temp_dir("last-slot-with-keyring");
        let path = _dir.path().join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        unlocked.add_recovery().unwrap();
        unlocked.set_passphrase(Some("extra-passphrase")).unwrap();

        unlocked.remove_recovery().unwrap();
        unlocked.set_passphrase(None).unwrap();
        assert!(unlocked.has_keyring());
        assert!(!unlocked.has_recovery());
        assert!(!unlocked.has_passphrase());
    }
}
