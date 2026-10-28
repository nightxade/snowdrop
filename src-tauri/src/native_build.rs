//! The native (GraalVM) build of the history-patched signal-cli, and what to do when it doesn't
//! work on this machine.
//!
//! `scripts/build-signal-cli.sh --native --install` puts it at `<app_data_dir>/bin/
//! signal-cli-history-native/signal-cli`, next to the Java build (`config::patched_binary`).
//! Snowdrop prefers it (it answers in tens of milliseconds and idles in less than half the
//! memory) and falls back to the Java build by itself when it can't run: it wouldn't start, it
//! exited before its first reply (a missing `libsignal_jni.so`, an older glibc), it never
//! answered, or it died with a native-image runtime error. The failure is remembered for that
//! exact build, so the next launch goes straight to the Java build; installing a new native
//! build (a different `PROVENANCE.txt`) tries native again. Nothing here ever logs content: only
//! the category of the failure.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::config::is_executable;

/// Set (to anything but empty or `0`) to run the Java build even when a native one is installed.
pub const FORCE_JVM_ENV: &str = "SNOWDROP_SIGNAL_CLI_JVM";

/// Why the native build was given up on. Only ever logged and stored by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureReason {
    /// The program couldn't be started at all.
    SpawnFailed,
    /// It exited before sending anything: it never got as far as answering.
    NoReply,
    /// It was running but didn't answer its first request in time.
    NoAnswer,
    /// It died after printing a native-image runtime error.
    NativeFault,
}

impl FailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SpawnFailed => "couldn't start",
            Self::NoReply => "exited before its first reply",
            Self::NoAnswer => "didn't answer",
            Self::NativeFault => "native-image runtime error",
        }
    }
}

/// Whether `value` of [`FORCE_JVM_ENV`] asks for the Java build.
pub fn jvm_forced(value: Option<&OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty() && v != "0")
}

/// A stderr line that only a native image prints when it hits something the image doesn't
/// contain (reflection, JNI or resource metadata that was never registered, a library that can't
/// load) or when the runtime itself aborts. A Java build never prints these.
pub fn is_native_fault_line(line: &str) -> bool {
    const MARKERS: &[&str] = &[
        "MissingReflectionRegistrationError",
        "MissingJNIRegistrationError",
        "MissingResourceRegistrationError",
        "MissingForeignRegistrationError",
        "MissingSerializationRegistrationError",
        "UnsatisfiedLinkError",
        "Fatal error:",
    ];
    MARKERS.iter().any(|m| line.contains(m))
}

/// `<app_data_dir>/bin/signal-cli-history-native/`.
fn native_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin").join("signal-cli-history-native")
}

/// The installed native build, if it's there and executable.
pub fn native_binary(app_data_dir: &Path) -> Option<PathBuf> {
    let path = native_dir(app_data_dir).join("signal-cli");
    is_executable(&path).then_some(path)
}

/// Identifies one installed native build: the hash of its `PROVENANCE.txt` (which changes with
/// every build), or, for a copy without one, its size and modification time.
pub fn build_key(binary: &Path) -> String {
    if let Some(text) = binary.parent().and_then(|dir| std::fs::read(dir.join("PROVENANCE.txt")).ok()) {
        return format!("{:x}", Sha256::digest(text));
    }
    let meta = std::fs::metadata(binary).ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    format!("unversioned-{}-{modified}", meta.map_or(0, |m| m.len()))
}

#[derive(Debug, Serialize, Deserialize)]
struct FailureRecord {
    key: String,
    reason: FailureReason,
}

/// Beside the install directories (never inside them, so a reinstall doesn't copy it forward and
/// the install script never has to know about it).
fn failure_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin").join("signal-cli-history-native.failed")
}

/// Remembers that `key` (a [`build_key`]) failed. Best effort: a write that fails only means the
/// next launch tries native once more.
pub fn record_failure(app_data_dir: &Path, key: &str, reason: FailureReason) {
    let file = failure_file(app_data_dir);
    let Ok(json) = serde_json::to_vec(&FailureRecord { key: key.to_owned(), reason }) else { return };
    let tmp = file.with_extension("failed.tmp");
    if std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &file)).is_err() {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("couldn't remember that the native signal-cli build failed");
    }
}

/// Whether `key` is the build [`record_failure`] last recorded.
pub fn has_failed(app_data_dir: &Path, key: &str) -> bool {
    std::fs::read(failure_file(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<FailureRecord>(&bytes).ok())
        .is_some_and(|record| record.key == key)
}

/// The native build to prefer, if there is one worth trying: installed, not switched off by
/// [`FORCE_JVM_ENV`], and not the build that already failed here.
pub fn preferred_native(app_data_dir: &Path, force_jvm: Option<&OsStr>) -> Option<PathBuf> {
    if jvm_forced(force_jvm) {
        return None;
    }
    let binary = native_binary(app_data_dir)?;
    (!has_failed(app_data_dir, &build_key(&binary))).then_some(binary)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn install(app_data: &Path, provenance: Option<&str>) -> PathBuf {
        let dir = native_dir(app_data);
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("signal-cli");
        fs::write(&bin, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        if let Some(text) = provenance {
            fs::write(dir.join("PROVENANCE.txt"), text).unwrap();
        }
        bin
    }

    #[test]
    fn force_jvm_env_values() {
        assert!(!jvm_forced(None));
        assert!(!jvm_forced(Some(OsStr::new(""))));
        assert!(!jvm_forced(Some(OsStr::new("0"))));
        assert!(jvm_forced(Some(OsStr::new("1"))));
        assert!(jvm_forced(Some(OsStr::new("yes"))));
    }

    #[test]
    fn recognises_only_native_image_failures() {
        for line in [
            "com.oracle.svm.core.jni.access.MissingJNIRegistrationError: JNI registration is missing for x",
            "org.graalvm.nativeimage.MissingReflectionRegistrationError: The program tried to reflectively access x",
            "java.lang.UnsatisfiedLinkError: no foo in java.library.path",
            "Fatal error: java.lang.InterruptedException",
        ] {
            assert!(is_native_fault_line(line), "{line}");
        }
        for line in [
            "WARN  Manager - Failed to retrieve profile for x, ignoring: [404] Profile not found",
            "INFO  fake signal-cli started",
            "Missing required native library dependency: libsignal-client",
        ] {
            assert!(!is_native_fault_line(line), "{line}");
        }
    }

    #[test]
    fn the_key_follows_the_provenance_file() {
        let dir = tempfile::tempdir().unwrap();
        let bin = install(dir.path(), Some("Built: 1\n"));
        let first = build_key(&bin);
        assert_eq!(first, build_key(&bin), "stable for the same build");
        fs::write(bin.parent().unwrap().join("PROVENANCE.txt"), "Built: 2\n").unwrap();
        assert_ne!(first, build_key(&bin), "a new build has a new key");
        fs::remove_file(bin.parent().unwrap().join("PROVENANCE.txt")).unwrap();
        assert!(build_key(&bin).starts_with("unversioned-"));
    }

    #[test]
    fn a_failure_is_remembered_for_that_build_only() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        let bin = install(app, Some("Built: 1\n"));
        assert_eq!(preferred_native(app, None), Some(bin.clone()));

        record_failure(app, &build_key(&bin), FailureReason::NoReply);
        assert_eq!(preferred_native(app, None), None, "the failed build is skipped");

        // A newly installed build is tried again, with the old record still on disk.
        fs::write(bin.parent().unwrap().join("PROVENANCE.txt"), "Built: 2\n").unwrap();
        assert_eq!(preferred_native(app, None), Some(bin));
    }

    #[test]
    fn nothing_installed_or_forced_off_means_no_native_build() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        assert_eq!(preferred_native(app, None), None);
        install(app, Some("Built: 1\n"));
        assert_eq!(preferred_native(app, Some(OsStr::new("1"))), None);
        assert!(preferred_native(app, Some(OsStr::new("0"))).is_some());
    }

    #[test]
    fn an_unreadable_record_counts_as_no_failure() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        let bin = install(app, Some("Built: 1\n"));
        fs::write(failure_file(app), "not json").unwrap();
        assert!(!has_failed(app, &build_key(&bin)));
    }
}
