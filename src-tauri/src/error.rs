//! Errors the UI can act on: the `kind` maps onto the adapter's
//! `SignalCliError` kinds (see src/platform/tauri/TauriTransport.ts).

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// signal-cli isn't running (crashed, restarting, external daemon down).
    Unreachable,
    Timeout,
    /// No signal-cli program could be found.
    NotInstalled,
    /// A setting failed validation (path, account, daemon URL).
    Config,
    /// signal-cli answered with something that isn't JSON-RPC.
    InvalidResponse,
    /// The caller cancelled an in-progress operation (e.g. the signal-cli download).
    Cancelled,
    /// No OS keyring service is reachable (no Secret Service on the bus, no
    /// backend at all) or it didn't answer within the timeout.
    KeyringUnavailable,
    /// The keyring is reachable but locked, refused access, or a prompt was dismissed.
    KeyringLocked,
    /// The keyring answered, but its stored value isn't a well-formed slot secret.
    KeyringCorrupt,
    /// The keyring slot in `keys.json` expects a secret, but the OS keyring
    /// has none (e.g. it was wiped, or a fresh keyring provider took over).
    /// Distinct from `KeyringCorrupt` (a secret exists but is malformed) and
    /// from `KeyringLocked`/`KeyringUnavailable` (the service itself).
    KeyringSecretMissing,
    /// A passphrase, recovery code or keyring secret didn't unwrap the DEK:
    /// wrong secret, or (for a keyring/recovery/passphrase mismatch) a
    /// tampered or swapped slot. Never distinguishes which, on purpose.
    AuthFailed,
    /// `keys.json` has no slot of the requested type.
    SlotMissing,
    /// `keys.json` doesn't parse, or its format version/fields aren't ones
    /// this build understands.
    KeysFileCorrupt,
    /// A recovery code's checksum didn't match before any KDF ran: almost
    /// always a typo, not a wrong-but-well-formed code.
    RecoveryCodeTypo,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for Error {}
