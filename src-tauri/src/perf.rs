//! Timing instrumentation for Tauri commands: a freeze on the user's
//! machine (whole window stalling for a couple of seconds) could come from
//! either side of the IPC boundary — this is the Rust-side half, matching
//! the frontend's `perf` scope (`src/platform/tauri/ipc.ts`,
//! `src/app/perf.ts`). Nothing here changes behaviour; it only logs.

use std::time::Instant;

/// Commands slower than this are logged at `warn`, target `rust:perf`.
const SLOW_MS: u128 = 200;

/// Start one at the top of a command's body (sync body, or the
/// `spawn_blocking` closure for an async one) and let it drop at the end.
/// Logs the command's name and elapsed time if it ran longer than
/// [`SLOW_MS`] — never any argument or result, just the name already given
/// at the call site.
pub struct CommandTimer {
    name: &'static str,
    detail: Option<&'static str>,
    started: Instant,
}

impl CommandTimer {
    pub fn start(name: &'static str) -> Self {
        Self { name, detail: None, started: Instant::now() }
    }

    /// Like [`CommandTimer::start`], plus a fixed label logged after the name
    /// (e.g. which signal-cli method a `signal_cli_request` carried). Static
    /// only, so it can never carry an argument.
    pub fn start_with_detail(name: &'static str, detail: &'static str) -> Self {
        Self { name, detail: Some(detail), started: Instant::now() }
    }
}

impl Drop for CommandTimer {
    fn drop(&mut self) {
        log_if_slow(self.name, self.detail, self.started.elapsed().as_millis(), SLOW_MS);
    }
}

/// Split out of `Drop` so the threshold is a parameter the tests can shrink,
/// instead of actually sleeping past [`SLOW_MS`].
fn log_if_slow(name: &str, detail: Option<&str>, ms: u128, threshold: u128) {
    if ms > threshold {
        match detail {
            Some(detail) => log::warn!(target: "rust:perf", "{name} {detail} took {ms} ms"),
            None => log::warn!(target: "rust:perf", "{name} took {ms} ms"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{log_if_slow, CommandTimer};

    #[test]
    fn the_guard_runs_on_drop_without_panicking() {
        let _t = CommandTimer::start("some_command");
    }

    #[test]
    fn logs_only_once_past_the_threshold() {
        // No in-process subscriber to assert against (the app installs its
        // own `Log` impl at runtime — see `applog.rs`); this only proves
        // the comparison is the right way round and never panics.
        log_if_slow("under", None, 100, 200);
        log_if_slow("at", None, 200, 200);
        log_if_slow("over", None, 201, 200);
        log_if_slow("over", Some("detail"), 201, 200);
    }
}
