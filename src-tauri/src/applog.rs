//! The one `log::Log` for the whole app: every `log::warn!`/`info!`/etc.
//! call across the Rust code, the frontend's own log calls
//! (`commands::frontend_log`, target `ui:<scope>`) and signal-cli's stderr
//! (`process::drain_stderr`, target `signal-cli`) all funnel through here.
//!
//! Each line looks like:
//! ```text
//! 2026-10-06T09:12:03.123Z WARN  rust:vault  message
//! ```
//! and goes to both stderr and a single redacted file, `snowdrop.log`
//! (rotated once to `snowdrop.log.1` past 1 MiB — [`crate::logfile::LogFile`]).
//!
//! Default level is [`log::LevelFilter::Warn`]. `SNOWDROP_LOG`
//! (error|warn|info|debug|trace) overrides that at startup; [`set_verbose`]
//! raises the floor to Debug at runtime (Settings → a developer toggle),
//! without ever lowering a stricter `SNOWDROP_LOG`. Either way, a fixed set
//! of chatty dependency targets ([`QUIET_DEPENDENCIES`]) is kept at Warn —
//! their own Debug/Trace output is never useful for Snowdrop's own bugs.

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use crate::logfile::LogFile;
use crate::redact::redact;

/// Dependency targets kept at Warn even with [`set_verbose`] on.
const QUIET_DEPENDENCIES: &[&str] = &["tao", "wry", "zbus", "hyper", "reqwest", "tungstenite", "tracing", "rustls"];

static LOGGER: OnceLock<Logger> = OnceLock::new();
static VERBOSE: AtomicBool = AtomicBool::new(false);

/// Raises the running app's level floor to Debug (or back down to whatever
/// `SNOWDROP_LOG`/the default set at startup), for a developer toggle in
/// Settings. Takes effect on the next log call; nothing to restart.
pub fn set_verbose(verbose: bool) {
    VERBOSE.store(verbose, Ordering::Relaxed);
}

/// Installs the app-wide logger. Must be called exactly once, as early as
/// `app_log_dir()` can be resolved (`lib.rs`'s `setup()`, before anything
/// else runs there) — every `log::` call before this one is silently
/// dropped, same as today with no logger installed at all.
pub fn install(log_path: PathBuf) {
    let base_level = std::env::var("SNOWDROP_LOG").ok().as_deref().and_then(parse_level).unwrap_or(LevelFilter::Warn);
    let logger = LOGGER.get_or_init(|| Logger::new(log_path, base_level));
    // The real per-record filtering happens in `Logger::enabled`, which
    // knows about `SNOWDROP_LOG`, `set_verbose` and the quiet-dependency
    // list; the crate-wide max level just needs to be loose enough to let
    // everything reach that logic.
    log::set_max_level(LevelFilter::Trace);
    let _ = log::set_logger(logger);
}

/// The tail of `snowdrop.log` (plus `snowdrop.log.1` if more is needed to
/// fill the request), already redacted because it was written redacted.
/// `max_bytes` is capped server-side at 256 KiB regardless of what's asked.
pub fn recent(max_bytes: usize) -> String {
    const HARD_CAP: usize = 256 * 1024;
    match LOGGER.get() {
        Some(logger) => logger.tail(max_bytes.min(HARD_CAP)),
        None => String::new(),
    }
}

fn parse_level(s: &str) -> Option<LevelFilter> {
    match s.to_ascii_lowercase().as_str() {
        "error" => Some(LevelFilter::Error),
        "warn" | "warning" => Some(LevelFilter::Warn),
        "info" => Some(LevelFilter::Info),
        "debug" => Some(LevelFilter::Debug),
        "trace" => Some(LevelFilter::Trace),
        _ => None,
    }
}

fn is_quiet(target: &str) -> bool {
    QUIET_DEPENDENCIES.iter().any(|dep| target == *dep || target.starts_with(&format!("{dep}::")))
}

/// Combines the configured base level with the runtime verbose toggle,
/// without the quiet-dependency cap (that's applied separately, against
/// the un-prefixed target, by the caller).
fn effective_level(base: LevelFilter, verbose: bool) -> LevelFilter {
    if verbose {
        base.max(LevelFilter::Debug)
    } else {
        base
    }
}

fn level_str(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug => "DEBUG",
        Level::Trace => "TRACE",
    }
}

/// `snowdrop_lib::vault` → `rust:vault`; `ui:settings` and `signal-cli` pass
/// through unchanged (they're already tagged by their own call sites).
fn display_target(target: &str) -> String {
    if target == "signal-cli" || target.starts_with("ui:") {
        return target.to_string();
    }
    let module = target.strip_prefix("snowdrop_lib::").or_else(|| target.strip_prefix("snowdrop_lib")).unwrap_or(target);
    let module = if module.is_empty() { "lib" } else { module };
    format!("rust:{module}")
}

fn format_line(level: Level, target: &str, message: &str) -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    let target = display_target(target);
    format!("{now} {:<5} {target}  {message}", level_str(level))
}

pub struct Logger {
    file: LogFile,
    path: PathBuf,
    base_level: LevelFilter,
}

impl Logger {
    fn new(path: PathBuf, base_level: LevelFilter) -> Self {
        Self { file: LogFile::new(path.clone()), path, base_level }
    }

    /// The formatting/redaction/writing core, independent of the `log::Log`
    /// plumbing so it's directly unit-testable without touching the global
    /// logger singleton.
    fn record(&self, level: Level, target: &str, message: &str) {
        let line = format_line(level, target, &redact(message));
        eprintln!("{line}");
        self.file.append(&line);
    }

    fn tail(&self, cap: usize) -> String {
        let current = std::fs::read(&self.path).unwrap_or_default();
        let mut buf = Vec::new();
        if current.len() < cap {
            let mut rotated_path = self.path.clone().into_os_string();
            rotated_path.push(".1");
            if let Ok(rotated) = std::fs::read(&rotated_path) {
                let need = cap - current.len();
                let from = rotated.len().saturating_sub(need);
                buf.extend_from_slice(&rotated[from..]);
            }
        }
        let room = cap.saturating_sub(buf.len());
        let from = current.len().saturating_sub(room);
        buf.extend_from_slice(&current[from..]);
        String::from_utf8_lossy(&buf).into_owned()
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let mut level = effective_level(self.base_level, VERBOSE.load(Ordering::Relaxed));
        if is_quiet(metadata.target()) {
            level = level.min(LevelFilter::Warn);
        }
        metadata.level() <= level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        self.record(record.level(), record.target(), &record.args().to_string());
    }

    fn flush(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-applog-test-{name}-{}-", std::process::id())).tempdir().unwrap()
    }

    #[test]
    fn formats_a_line_like_the_spec_example() {
        let line = format_line(Level::Warn, "snowdrop_lib::vault", "message");
        // Timestamp varies; check the fixed shape around it, e.g.
        // "2026-10-06T09:12:03.123Z WARN  rust:vault  message".
        assert!(line.ends_with(" WARN  rust:vault  message"), "{line}");
        assert!(line.contains('T'), "{line}");
    }

    #[test]
    fn maps_targets_to_their_source_tag() {
        assert_eq!(display_target("snowdrop_lib::storage"), "rust:storage");
        assert_eq!(display_target("snowdrop_lib"), "rust:lib");
        assert_eq!(display_target("zbus::connection"), "rust:zbus::connection");
        assert_eq!(display_target("ui:settings"), "ui:settings");
        assert_eq!(display_target("signal-cli"), "signal-cli");
    }

    #[test]
    fn quiet_dependencies_are_matched_by_prefix_not_substring() {
        assert!(is_quiet("tao"));
        assert!(is_quiet("tao::event_loop"));
        assert!(!is_quiet("taobar"));
        assert!(!is_quiet("snowdrop_lib::storage"));
    }

    #[test]
    fn verbose_raises_the_floor_to_debug_but_never_lowers_a_stricter_base() {
        assert_eq!(effective_level(LevelFilter::Warn, false), LevelFilter::Warn);
        assert_eq!(effective_level(LevelFilter::Warn, true), LevelFilter::Debug);
        assert_eq!(effective_level(LevelFilter::Trace, true), LevelFilter::Trace);
        assert_eq!(effective_level(LevelFilter::Error, true), LevelFilter::Debug);
    }

    #[test]
    fn parses_the_env_var_levels_case_insensitively() {
        assert_eq!(parse_level("Debug"), Some(LevelFilter::Debug));
        assert_eq!(parse_level("TRACE"), Some(LevelFilter::Trace));
        assert_eq!(parse_level("nonsense"), None);
    }

    #[test]
    fn record_writes_a_redacted_line_to_stderr_and_file() {
        let dir = temp_dir("record");
        let logger = Logger::new(dir.path().join("snowdrop.log"), LevelFilter::Warn);
        logger.record(Level::Warn, "snowdrop_lib::vault", "contact +15551234567 synced");
        let written = std::fs::read_to_string(dir.path().join("snowdrop.log")).unwrap();
        assert!(written.contains("rust:vault"), "{written}");
        assert!(written.contains("<phone>"), "{written}");
        assert!(!written.contains("15551234567"), "{written}");
    }

    #[test]
    fn enabled_respects_base_level_and_quiet_dependencies() {
        let dir = temp_dir("enabled");
        let logger = Logger::new(dir.path().join("snowdrop.log"), LevelFilter::Warn);
        assert!(logger.enabled(&Metadata::builder().level(Level::Warn).target("snowdrop_lib::vault").build()));
        assert!(!logger.enabled(&Metadata::builder().level(Level::Info).target("snowdrop_lib::vault").build()));
        // Even if verbose were on, `tao` stays capped at Warn (tested via
        // the pure helper above); here just check the default, non-verbose
        // path already keeps it at Warn.
        assert!(!logger.enabled(&Metadata::builder().level(Level::Info).target("tao::event_loop").build()));
    }

    #[test]
    fn tail_concatenates_the_rotated_file_before_the_current_one() {
        let dir = temp_dir("tail");
        let path = dir.path().join("snowdrop.log");
        std::fs::write(format!("{}.1", path.display()), "older\n").unwrap();
        std::fs::write(&path, "newer\n").unwrap();
        let logger = Logger::new(path, LevelFilter::Warn);
        let out = logger.tail(1024);
        assert!(out.starts_with("older"), "{out}");
        assert!(out.ends_with("newer\n"), "{out}");
    }

    #[test]
    fn tail_caps_bytes_even_across_both_files() {
        let dir = temp_dir("tail-cap");
        let path = dir.path().join("snowdrop.log");
        std::fs::write(format!("{}.1", path.display()), "x".repeat(100)).unwrap();
        std::fs::write(&path, "y".repeat(100)).unwrap();
        let logger = Logger::new(path, LevelFilter::Warn);
        let out = logger.tail(50);
        assert_eq!(out.len(), 50);
        assert!(out.chars().all(|c| c == 'y'), "{out}");
    }
}
