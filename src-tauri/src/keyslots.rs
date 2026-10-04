//! `keys.json` — the LUKS-style keyslots that wrap the vault's data
//! encryption key (DEK) under the OS keyring, a recovery code or a
//! passphrase (docs/ENCRYPTION.md, "Key hierarchy"). Pure logic plus file
//! IO: no Tauri commands live here.
//!
//! The DEK itself never touches disk. Each slot stores `aead::seal(KEK,
//! DEK, aad)`, where `aad` is a hand-built, deterministic encoding of that
//! slot's own metadata (type, KDF algorithm, parameters, salt) plus the
//! file's `vault_id` — never serde output, so field order can't matter and
//! editing a parameter or swapping a wrapped blob between slots fails
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
    /// `wrapped` = `aead::seal(keyring secret, DEK, aad)`.
    Keyring { wrapped: String },
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

    fn wrapped(&self) -> &str {
        match self {
            Self::Keyring { wrapped } | Self::Recovery { wrapped, .. } | Self::Passphrase { wrapped, .. } => wrapped,
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
/// from its own metadata first. `kdf` is `None` for the keyring slot.
fn wrap_dek(dek: &Key32, kek: &Key32, vault_id: &[u8; VAULT_ID_LEN], kind: SlotKind, kdf: Option<KdfParams>) -> Result<Slot, Error> {
    // A placeholder just to compute the AAD before we have ciphertext; the
    // wrapped field itself is never part of the AAD (see module docs).
    let unwrapped = match kind {
        SlotKind::Keyring => Slot::Keyring { wrapped: String::new() },
        SlotKind::Recovery => Slot::Recovery { kdf: kdf.clone().expect("recovery slot needs kdf params"), wrapped: String::new() },
        SlotKind::Passphrase => Slot::Passphrase { kdf: kdf.clone().expect("passphrase slot needs kdf params"), wrapped: String::new() },
    };
    let aad = slot_aad(vault_id, &unwrapped)?;
    let wrapped = b64_encode(&aead::seal(kek, dek.as_bytes(), &aad));
    Ok(match kind {
        SlotKind::Keyring => Slot::Keyring { wrapped },
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
    pub fn unlock_keyring<S: SecretStore>(&self, slot: &KeyringSlot<S>) -> Result<Unlocked, Error> {
        let keyring_slot = self.file.slot(SlotKind::Keyring).ok_or_else(|| Error::new(ErrorKind::SlotMissing, "keys.json has no keyring slot."))?;
        let kek = slot
            .get()?
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

    /// Generates a fresh recovery code, replacing any existing recovery
    /// slot, and returns it — this is the only time it's ever available;
    /// only its Argon2id-wrapped DEK is kept.
    pub fn add_recovery(&mut self) -> Result<RecoveryCode, Error> {
        let code = RecoveryCode::generate()?;
        let kdf = new_kdf_params(RECOVERY_KDF)?;
        let kek = derive_kek(&code.0, &kdf)?;
        let vault_id = self.file.vault_id_bytes()?;
        let slot = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Recovery, Some(kdf))?;
        self.file.set_slot(slot);
        Ok(code)
    }

    pub fn remove_recovery(&mut self) {
        self.file.remove_slot(SlotKind::Recovery);
    }

    /// `None` removes the passphrase slot; `Some` replaces it.
    pub fn set_passphrase(&mut self, passphrase: Option<&str>) -> Result<(), Error> {
        match passphrase {
            None => {
                self.file.remove_slot(SlotKind::Passphrase);
                Ok(())
            }
            Some(pass) => {
                let kdf = new_kdf_params(PASSPHRASE_KDF)?;
                let kek = derive_kek(pass.as_bytes(), &kdf)?;
                let vault_id = self.file.vault_id_bytes()?;
                let slot = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Passphrase, Some(kdf))?;
                self.file.set_slot(slot);
                Ok(())
            }
        }
    }

    /// Re-enrols the keyring slot: generates a brand new keyring secret
    /// (via [`KeyringSlot::replace`], since this is a deliberate overwrite —
    /// e.g. switching providers after the old secret was lost) and rewraps
    /// the DEK under it.
    pub fn enroll_keyring<S: SecretStore>(&mut self, slot: &KeyringSlot<S>) -> Result<(), Error> {
        let kek = slot.replace()?;
        let vault_id = self.file.vault_id_bytes()?;
        let wrapped = wrap_dek(&self.dek, &kek, &vault_id, SlotKind::Keyring, None)?;
        self.file.set_slot(wrapped);
        Ok(())
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
    Ok(Some(Locked { path: path.to_path_buf(), file }))
}

fn refuse_if_exists(path: &Path) -> Result<(), Error> {
    if path.exists() {
        return Err(Error::new(ErrorKind::Config, "keys.json already exists; load and unlock it instead of initializing again."));
    }
    Ok(())
}

/// Creates a brand new `keys.json` with a single keyring slot. Refuses if
/// `path` already exists. A keyring secret left over without a `keys.json`
/// (an interrupted setup, a partial erase) wraps nothing, so it is replaced
/// rather than blocking setup forever.
pub fn init_with_keyring<S: SecretStore>(path: &Path, slot: &KeyringSlot<S>) -> Result<Unlocked, Error> {
    refuse_if_exists(path)?;
    let kek = slot.replace()?;
    let dek = Key32::random();
    let vault_id = random_vault_id()?;
    let mut file = KeyFile::new(vault_id);
    file.set_slot(wrap_dek(&dek, &kek, &vault_id, SlotKind::Keyring, None)?);
    let unlocked = Unlocked { path: path.to_path_buf(), dek, file };
    unlocked.save()?;
    Ok(unlocked)
}

/// Creates a brand new `keys.json` with a single passphrase slot. Refuses
/// if `path` already exists.
pub fn init_with_passphrase(path: &Path, passphrase: &str) -> Result<Unlocked, Error> {
    refuse_if_exists(path)?;
    let dek = Key32::random();
    let vault_id = random_vault_id()?;
    let mut file = KeyFile::new(vault_id);
    let kdf = new_kdf_params(PASSPHRASE_KDF)?;
    let kek = derive_kek(passphrase.as_bytes(), &kdf)?;
    file.set_slot(wrap_dek(&dek, &kek, &vault_id, SlotKind::Passphrase, Some(kdf))?);
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
    use crate::secrets::FakeStore;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snowdrop-keyslots-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn keyring_slot() -> KeyringSlot<FakeStore> {
        KeyringSlot::new(FakeStore::new())
    }

    #[test]
    fn init_and_unlock_through_keyring() {
        let path = temp_dir("keyring").join("keys.json");
        let slot = keyring_slot();
        let unlocked = init_with_keyring(&path, &slot).unwrap();
        let vault_key = unlocked.vault_key();

        let locked = load(&path).unwrap().unwrap();
        let reopened = locked.unlock_keyring(&slot).unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn init_and_unlock_through_passphrase() {
        let path = temp_dir("passphrase-init").join("keys.json");
        let unlocked = init_with_passphrase(&path, "correct horse battery staple").unwrap();
        let vault_key = unlocked.vault_key();

        let locked = load(&path).unwrap().unwrap();
        let reopened = locked.unlock_passphrase("correct horse battery staple").unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), vault_key.as_bytes());
    }

    #[test]
    fn init_and_unlock_through_recovery() {
        let path = temp_dir("recovery-init").join("keys.json");
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
        let path = temp_dir("wrong-pass").join("keys.json");
        init_with_passphrase(&path, "right one").unwrap();
        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_passphrase("wrong one").unwrap_err();
        assert_eq!(err.kind, ErrorKind::AuthFailed);
    }

    #[test]
    fn wrong_recovery_code_is_an_auth_failure() {
        let path = temp_dir("wrong-recovery").join("keys.json");
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
        let path = temp_dir("tamper-param").join("keys.json");
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
    fn tampered_salt_fails() {
        let path = temp_dir("tamper-salt").join("keys.json");
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
        let path = temp_dir("tamper-vault-id").join("keys.json");
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
        let path = temp_dir("swap-slots").join("keys.json");
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
        let path = temp_dir("reenroll").join("keys.json");
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
        let path = temp_dir("missing-slot").join("keys.json");
        init_with_passphrase(&path, "a passphrase").unwrap();
        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_keyring(&keyring_slot()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::SlotMissing);
    }

    #[test]
    fn removing_the_recovery_slot() {
        let path = temp_dir("remove-recovery").join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        let code = unlocked.add_recovery().unwrap();
        unlocked.remove_recovery();
        unlocked.save().unwrap();

        let locked = load(&path).unwrap().unwrap();
        let err = locked.unlock_recovery(&code.to_string()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::SlotMissing);
    }

    #[test]
    fn save_load_round_trip_and_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_dir("round-trip").join("keys.json");
        let slot = keyring_slot();
        let mut unlocked = init_with_keyring(&path, &slot).unwrap();
        unlocked.set_passphrase(Some("extra")).unwrap();
        unlocked.save().unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let locked = load(&path).unwrap().unwrap();
        assert_eq!(locked.file.slots.len(), 2);
        assert_eq!(locked.file.vault_id, unlocked.file.vault_id);
    }

    #[test]
    fn init_refuses_if_the_file_already_exists() {
        let path = temp_dir("refuse-exists").join("keys.json");
        init_with_passphrase(&path, "first").unwrap();
        let err = init_with_passphrase(&path, "second").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        let err = init_with_keyring(&path, &keyring_slot()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
    }

    #[test]
    fn load_of_a_missing_file_is_none() {
        let path = temp_dir("load-missing").join("keys.json");
        assert!(load(&path).unwrap().is_none());
    }

    #[test]
    fn load_rejects_a_malformed_file() {
        let path = temp_dir("malformed").join("keys.json");
        fs::write(&path, b"not json").unwrap();
        let err = load(&path).unwrap_err();
        assert_eq!(err.kind, ErrorKind::KeysFileCorrupt);
    }

    #[test]
    fn load_rejects_an_unknown_format_version() {
        let path = temp_dir("future-format").join("keys.json");
        fs::write(&path, r#"{"format":99,"vault_id":"AAAA","slots":[]}"#).unwrap();
        let err = load(&path).unwrap_err();
        assert_eq!(err.kind, ErrorKind::KeysFileCorrupt);
    }

    #[test]
    fn init_with_keyring_replaces_an_orphaned_keyring_secret() {
        let path = temp_dir("keyring-orphaned-secret").join("keys.json");
        let slot = keyring_slot();
        let stale = slot.create_new().unwrap();
        let unlocked = init_with_keyring(&path, &slot).unwrap();
        let current = slot.get().unwrap().unwrap();
        assert_ne!(current.as_bytes(), stale.as_bytes());
        let reopened = load(&path).unwrap().unwrap().unlock_keyring(&slot).unwrap();
        assert_eq!(reopened.vault_key().as_bytes(), unlocked.vault_key().as_bytes());
    }
}
