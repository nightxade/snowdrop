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
