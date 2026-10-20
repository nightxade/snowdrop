//! The managed signal-cli child: `signal-cli … jsonRpc` with JSON-RPC on
//! stdin/stdout. Requests are matched to responses by id; notifications go
//! to a callback; stderr is drained into a size-capped log file. If the
//! process exits unexpectedly it is restarted with exponential backoff
//! (reset once it has stayed up for a while); `shutdown` closes stdin (which
//! makes signal-cli save its state and exit) and kills it if it lingers.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::error::{Error, ErrorKind};
use crate::jsonrpc::{parse_line, request_line, FrameError, Incoming};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ProcessState {
    #[serde(rename_all = "camelCase")]
    Starting { attempt: u32 },
    /// Up and answering on stdin; `generation` counts (re)starts.
    #[serde(rename_all = "camelCase")]
    Running { generation: u64 },
    #[serde(rename_all = "camelCase")]
    Restarting { attempt: u32, delay_ms: u64, reason: String },
    /// Couldn't start at all (missing or broken program); not retried.
    #[serde(rename_all = "camelCase")]
    Failed { kind: ErrorKind, message: String },
    Stopped,
}

#[derive(Debug, Clone)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
    /// Up this long ⇒ the next crash starts the backoff over.
    pub stable_after: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self { initial: Duration::from_secs(1), max: Duration::from_secs(30), stable_after: Duration::from_secs(60) }
    }
}

impl Backoff {
    pub fn delay(&self, attempt: u32) -> Duration {
        self.initial.saturating_mul(2u32.saturating_pow(attempt.min(16))).min(self.max)
    }
}

pub struct ProcessOptions {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Extra environment variables for the child only (e.g. `MALLOC_ARENA_MAX`
    /// on Linux, `config::spawn_env`); the child otherwise inherits ours.
    pub envs: Vec<(OsString, OsString)>,
    pub backoff: Backoff,
    /// How long `shutdown` waits after closing stdin before killing.
    pub grace: Duration,
}

pub type NotificationSink = Arc<dyn Fn(String, Value) + Send + Sync>;
pub type StateSink = Arc<dyn Fn(&ProcessState) + Send + Sync>;

struct Shared {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    writer: Mutex<Option<mpsc::UnboundedSender<String>>>,
    state: watch::Sender<ProcessState>,
    on_notification: NotificationSink,
    on_state: StateSink,
}

impl Shared {
    fn set_state(&self, state: ProcessState) {
        (self.on_state)(&state);
        self.state.send_replace(state);
    }

    fn fail_pending(&self) {
        // Dropping the senders wakes every waiter with "stopped before answering".
        self.pending.lock().expect("pending lock").clear();
    }
}

pub struct RpcProcess {
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

impl RpcProcess {
    /// Starts the supervisor (on the current tokio runtime).
    pub fn start(options: ProcessOptions, on_notification: NotificationSink, on_state: StateSink) -> Self {
        let (state, _) = watch::channel(ProcessState::Starting { attempt: 0 });
        let shared = Arc::new(Shared {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            writer: Mutex::new(None),
            state,
            on_notification,
            on_state,
        });
        let (shutdown, shutdown_rx) = watch::channel(false);
        let supervisor = tokio::spawn(supervise(shared.clone(), options, shutdown_rx));
        Self { shared, shutdown, supervisor: Mutex::new(Some(supervisor)) }
    }

    pub fn state(&self) -> ProcessState {
        self.shared.state.borrow().clone()
    }

    /// Resolves once signal-cli is running, or fails if it can't start.
    pub async fn wait_running(&self, timeout: Duration) -> Result<u64, Error> {
        let mut rx = self.shared.state.subscribe();
        let wait = async {
            loop {
                match &*rx.borrow_and_update() {
                    ProcessState::Running { generation } => return Ok(*generation),
                    ProcessState::Failed { kind, message } => return Err(Error::new(*kind, message.clone())),
                    ProcessState::Stopped => return Err(Error::new(ErrorKind::Unreachable, "signal-cli was stopped.")),
                    _ => {}
                }
                if rx.changed().await.is_err() {
                    return Err(Error::new(ErrorKind::Unreachable, "signal-cli was stopped."));
                }
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .unwrap_or_else(|_| Err(Error::new(ErrorKind::Timeout, "signal-cli didn't start in time.")))
    }

    /// One JSON-RPC call; resolves with the reply (`{ result }` or `{ error }`).
    pub async fn request(&self, method: &str, params: Option<&Map<String, Value>>, timeout: Duration) -> Result<Value, Error> {
        let writer = self
            .shared
            .writer
            .lock()
            .expect("writer lock")
            .clone()
            .ok_or_else(|| Error::new(ErrorKind::Unreachable, "signal-cli isn't running right now."))?;
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().expect("pending lock").insert(id, tx);
        if writer.send(request_line(id, method, params)).is_err() {
            self.shared.pending.lock().expect("pending lock").remove(&id);
            return Err(Error::new(ErrorKind::Unreachable, "signal-cli isn't running right now."));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(Error::new(ErrorKind::Unreachable, "signal-cli stopped before answering.")),
            Err(_) => {
                self.shared.pending.lock().expect("pending lock").remove(&id);
                Err(Error::new(ErrorKind::Timeout, format!("signal-cli didn't answer {method} within {} s.", timeout.as_secs())))
            }
        }
    }

    /// Stops signal-cli (and the restart loop) and waits for it to exit.
    pub async fn shutdown(&self) {
        self.shutdown.send_replace(true);
        let handle = self.supervisor.lock().expect("supervisor lock").take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }

    /// Requests in flight (for tests).
    pub fn pending_count(&self) -> usize {
        self.shared.pending.lock().expect("pending lock").len()
    }
}

impl Drop for RpcProcess {
    fn drop(&mut self) {
        // The child has kill_on_drop; this also ends the restart loop.
        self.shutdown.send_replace(true);
    }
}

async fn supervise(shared: Arc<Shared>, options: ProcessOptions, mut shutdown: watch::Receiver<bool>) {
    let mut attempt: u32 = 0;
    let mut generation: u64 = 0;
    loop {
        if *shutdown.borrow() {
            break;
        }
        shared.set_state(ProcessState::Starting { attempt });
        let mut command = Command::new(&options.program);
        command
            .args(&options.args)
            .envs(options.envs.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let kind = if error.kind() == std::io::ErrorKind::NotFound { ErrorKind::NotInstalled } else { ErrorKind::Internal };
                let message = format!("Couldn't start signal-cli ({}): {error}", options.program.display());
                log::error!("{message}");
                shared.set_state(ProcessState::Failed { kind, message });
                return;
            }
        };
        generation += 1;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            shared.set_state(ProcessState::Failed { kind: ErrorKind::Internal, message: "signal-cli's pipes are missing.".into() });
            return;
        };
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        *shared.writer.lock().expect("writer lock") = Some(tx);
        let writer = tokio::spawn(write_loop(stdin, rx));
        let reader = tokio::spawn(read_loop(stdout, shared.clone()));
        let drain = tokio::spawn(drain_stderr(stderr, shutdown.clone()));
        shared.set_state(ProcessState::Running { generation });
        let started = Instant::now();

        let exited = tokio::select! {
            status = child.wait() => Some(status),
            _ = shutdown.changed() => None,
        };
        // No new requests from here; closing the channel also closes stdin.
        shared.writer.lock().expect("writer lock").take();
        match exited {
            None => {
                stop_child(&mut child, writer, options.grace).await;
                let _ = reader.await;
                let _ = drain.await;
                shared.fail_pending();
                shared.set_state(ProcessState::Stopped);
                return;
            }
            Some(status) => {
                writer.abort();
                let _ = reader.await;
                let _ = drain.await;
                shared.fail_pending();
                if started.elapsed() >= options.backoff.stable_after {
                    attempt = 0;
                }
                let delay = options.backoff.delay(attempt);
                attempt += 1;
                let reason = match status {
                    Ok(status) => format!("signal-cli exited ({status})"),
                    Err(error) => format!("signal-cli was lost ({error})"),
                };
                log::warn!("{reason}; restarting in {} ms", delay.as_millis());
                shared.set_state(ProcessState::Restarting { attempt, delay_ms: delay.as_millis() as u64, reason });
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = shutdown.changed() => {
                        shared.set_state(ProcessState::Stopped);
                        return;
                    }
                }
            }
        }
    }
    shared.set_state(ProcessState::Stopped);
}

/// Closes stdin (signal-cli then saves and exits), waits `grace`, then kills.
async fn stop_child(child: &mut Child, writer: JoinHandle<()>, grace: Duration) {
    let _ = writer.await;
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

async fn write_loop(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
    // Dropping stdin closes it.
}

async fn read_loop(stdout: impl AsyncRead + Unpin, shared: Arc<Shared>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        match parse_line(&line) {
            Ok(Incoming::Response { id, reply }) => {
                let waiter = shared.pending.lock().expect("pending lock").remove(&id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(reply);
                }
            }
            Ok(Incoming::Notification { method, params }) => (shared.on_notification)(method, params),
            Err(FrameError::ForeignId(id)) => log::warn!("signal-cli answered an unknown request id {id}"),
            Err(_) => log::warn!("unexpected output from signal-cli ({} bytes, not a JSON-RPC frame)", line.len()),
        }
    }
}

/// A small, deliberately narrow allowlist of signal-cli WARN lines that are
/// routine, not actionable — confirmed against signal-cli's own source
/// (`lib/.../manager/helper/ProfileHelper.java`): fetching a contact's
/// profile 404s whenever they haven't set one up (or signal-cli hasn't
/// fetched it yet), which is normal for a new or inactive contact, not
/// something the user can or needs to act on. Kept small on purpose:
/// broadening this risks quietly hiding an actual problem. Each entry is a
/// pair of substrings that must *both* appear in the line (the call site's
/// own wording, and the 404 that makes it benign) — this is deliberately
/// narrower than matching on "Failed to retrieve profile" alone, which
/// ProfileHelper also logs at WARN for real I/O failures that should stay
/// at Warn.
const KNOWN_BENIGN_SIGNAL_CLI_WARNINGS: &[(&str, &str)] = &[
    ("Failed to retrieve profile for", "[404]"),
    ("Failed to retrieve profile key credential for", "[404]"),
];

fn is_known_benign_signal_cli_warning(line: &str) -> bool {
    KNOWN_BENIGN_SIGNAL_CLI_WARNINGS.iter().any(|(a, b)| line.contains(a) && line.contains(b))
}

/// signal-cli's stderr, one line at a time, through the app-wide logger
/// (`crate::applog`) at target `signal-cli`. Two kinds of noise are
/// smoothed out before anything is logged:
/// - A JVM crash dump's native memory map is huge (one line per
///   register/stack slot, each starting `  |0x...`); a run of those is
///   collapsed into one summary line instead of logging each one (see
///   [`flush_crash_dump_run`]), at Info if it happened while Snowdrop was
///   already shutting the child down (a known, harmless GraalVM
///   native-image teardown bug) and at Error otherwise.
/// - A handful of known-benign WARN lines are logged at Info instead (see
///   [`KNOWN_BENIGN_SIGNAL_CLI_WARNINGS`]).
async fn drain_stderr(stderr: impl AsyncRead + Unpin, shutting_down: watch::Receiver<bool>) {
    let mut lines = BufReader::new(stderr).lines();
    let mut crash_dump_run: u32 = 0;
    // The line right before a crash-dump run started, if any: usually the
    // JVM's own one-line description of the crash (e.g. "Fatal error:
    // java.lang.…"), included in the summary so it isn't left to scroll
    // past unexplained register/stack dump lines to find.
    let mut line_before_dump: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.starts_with("  |0x") {
            crash_dump_run += 1;
            continue;
        }
        flush_crash_dump_run(&mut crash_dump_run, line_before_dump.take(), &shutting_down);
        if line.trim().is_empty() {
            continue;
        }
        let level = stderr_level(&line);
        let level = if level == log::Level::Warn && is_known_benign_signal_cli_warning(&line) {
            log::Level::Info
        } else {
            level
        };
        log::log!(target: "signal-cli", level, "{}", truncate(&line, 500));
        line_before_dump = Some(line);
    }
    flush_crash_dump_run(&mut crash_dump_run, line_before_dump.take(), &shutting_down);
}

/// The pure decision behind [`flush_crash_dump_run`] — split out so its
/// three outcomes (shutting down; a real crash with a clue to the cause;
/// a real crash with none) are each unit-testable without a global
/// `log::Logger` installed. Shutdown already requested
/// (`RpcProcess::shutdown`, which closes stdin before anything else) means
/// this is the known GraalVM native-image teardown crash — harmless, logged
/// once at Info; otherwise it's a real crash, logged at Error with
/// `context_line` (the line just before the dump, if any) appended as a
/// clue to the cause without needing the full dump.
fn crash_dump_outcome(run: u32, context_line: Option<&str>, shutting_down: bool) -> (log::Level, String) {
    if shutting_down {
        (
            log::Level::Info,
            "signal-cli crashed while shutting down (known GraalVM native-image teardown bug; harmless)".to_string(),
        )
    } else if let Some(context) = context_line {
        (log::Level::Error, format!("signal-cli crashed ({run} crash-dump lines collapsed): {}", truncate(context, 200)))
    } else {
        (log::Level::Error, format!("signal-cli crashed ({run} crash-dump lines collapsed)"))
    }
}

/// Logs a just-ended crash-dump run; a no-op if `run` is 0 (nothing to flush).
fn flush_crash_dump_run(run: &mut u32, context_line: Option<String>, shutting_down: &watch::Receiver<bool>) {
    if *run == 0 {
        return;
    }
    let (level, message) = crash_dump_outcome(*run, context_line.as_deref(), *shutting_down.borrow());
    log::log!(target: "signal-cli", level, "{message}");
    *run = 0;
}

/// signal-cli (logback) lines start with a level word, e.g. `WARN  Foo: …`
/// or `21:03:45.123 [main] WARN  Foo - …`. Only the first few
/// whitespace-separated tokens are checked (not the whole line, which may
/// go on to contain the word "error" as ordinary text): WARN/ERROR there
/// are kept at Warn; anything else, including no recognisable level word at
/// all, is Info.
fn stderr_level(line: &str) -> log::Level {
    let is_level_word = |token: &str| {
        matches!(token.trim_matches(|c: char| !c.is_ascii_alphabetic()), "ERROR" | "WARN" | "WARNING")
    };
    if line.split_whitespace().take(4).any(is_level_word) {
        log::Level::Warn
    } else {
        log::Level::Info
    }
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Once, OnceLock};

    #[test]
    fn backs_off_exponentially_up_to_a_cap() {
        let b = Backoff { initial: Duration::from_millis(100), max: Duration::from_secs(1), stable_after: Duration::from_secs(5) };
        let delays: Vec<u128> = (0..6).map(|a| b.delay(a).as_millis()).collect();
        assert_eq!(delays, vec![100, 200, 400, 800, 1000, 1000]);
        assert_eq!(b.delay(u32::MAX), Duration::from_secs(1));
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("héllo", 2), "hé");
        assert_eq!(truncate("hi", 5), "hi");
    }

    #[test]
    fn stderr_level_recognises_a_leading_level_word() {
        assert_eq!(stderr_level("INFO  fake signal-cli started (account +15550001)"), log::Level::Info);
        assert_eq!(stderr_level("WARN  something's off"), log::Level::Warn);
        assert_eq!(stderr_level("ERROR couldn't open the database"), log::Level::Warn);
        assert_eq!(stderr_level("21:03:45.123 [main] WARN  org.asamk.signal - retrying"), log::Level::Warn);
    }

    #[test]
    fn stderr_level_defaults_to_info_with_no_recognisable_level() {
        assert_eq!(stderr_level("just some plain output"), log::Level::Info);
        // The word appearing later in the line, as ordinary text, doesn't count.
        assert_eq!(stderr_level("connection reset: no error code available"), log::Level::Info);
    }

    #[test]
    fn recognises_the_documented_benign_profile_404_warnings() {
        assert!(is_known_benign_signal_cli_warning(
            "21:03:45.123 [main] WARN  ProfileHelper - Failed to retrieve profile for 11111111-1111-4111-8111-111111111111, ignoring: [404] Profile not found"
        ));
        assert!(is_known_benign_signal_cli_warning(
            "WARN  ProfileHelper - Failed to retrieve profile key credential for 2222, ignoring: [404] Profile not found"
        ));
    }

    #[test]
    fn does_not_treat_other_profile_failures_or_warnings_as_benign() {
        // Same call site, but a real I/O failure rather than a 404: must
        // stay at whatever level `stderr_level` gave it.
        assert!(!is_known_benign_signal_cli_warning(
            "WARN  ProfileHelper - Failed to retrieve profile for 1234, ignoring: java.io.IOException: timeout"
        ));
        assert!(!is_known_benign_signal_cli_warning("WARN  something unrelated went wrong"));
    }

    #[test]
    fn crash_dump_outcome_is_info_once_shutdown_was_requested() {
        let (level, message) = crash_dump_outcome(122, Some("Fatal error: java.lang.NullPointerException"), true);
        assert_eq!(level, log::Level::Info);
        assert_eq!(message, "signal-cli crashed while shutting down (known GraalVM native-image teardown bug; harmless)");
    }

    #[test]
    fn crash_dump_outcome_is_an_error_with_its_cause_otherwise() {
        let (level, message) = crash_dump_outcome(3, Some("Fatal error: java.lang.NullPointerException"), false);
        assert_eq!(level, log::Level::Error);
        assert_eq!(message, "signal-cli crashed (3 crash-dump lines collapsed): Fatal error: java.lang.NullPointerException");
    }

    #[test]
    fn crash_dump_outcome_without_a_context_line_still_reports_the_count() {
        let (level, message) = crash_dump_outcome(5, None, false);
        assert_eq!(level, log::Level::Error);
        assert_eq!(message, "signal-cli crashed (5 crash-dump lines collapsed)");
    }

    // ─── drain_stderr, end to end ──────────────────────────────────────

    /// A `log::Log` that just remembers every record (same pattern as
    /// `tests/signal_cli.rs`'s `CapturingLogger`): installed once for this
    /// binary's unit tests, since `log::set_logger` only accepts one logger
    /// per process. Tests filter the shared log by a message they chose
    /// themselves to be unique, so they stay independent under parallel
    /// execution.
    struct CapturingLogger(Mutex<Vec<(log::Level, String)>>);

    static CAPTURE: OnceLock<CapturingLogger> = OnceLock::new();

    impl log::Log for CapturingLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            if record.target() == "signal-cli" {
                self.0.lock().unwrap().push((record.level(), record.args().to_string()));
            }
        }
        fn flush(&self) {}
    }

    fn capturing_logger() -> &'static CapturingLogger {
        let logger = CAPTURE.get_or_init(|| CapturingLogger(Mutex::new(Vec::new())));
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            log::set_max_level(log::LevelFilter::Trace);
            let _ = log::set_logger(logger);
        });
        logger
    }

    /// Runs `drain_stderr` over `input` to completion and returns every
    /// `target: "signal-cli"` record logged while doing so, in order.
    async fn drain(input: &str, shutting_down: bool) -> Vec<(log::Level, String)> {
        let logger = capturing_logger();
        let before = logger.0.lock().unwrap().len();
        let (tx, rx) = watch::channel(shutting_down);
        let _ = &tx; // kept alive for the duration of the call
        drain_stderr(input.as_bytes(), rx).await;
        logger.0.lock().unwrap()[before..].to_vec()
    }

    #[tokio::test]
    async fn downgrades_a_known_benign_profile_404_to_info() {
        let marker = "drain-marker-benign-404";
        let line = format!(
            "WARN  ProfileHelper - Failed to retrieve profile for {marker}, ignoring: [404] Profile not found"
        );
        let got = drain(&format!("{line}\n"), false).await;
        let matching: Vec<_> = got.into_iter().filter(|(_, m)| m.contains(marker)).collect();
        assert_eq!(matching, vec![(log::Level::Info, line)]);
    }

    #[tokio::test]
    async fn collapses_a_crash_dump_into_one_error_line_with_its_cause() {
        let marker = "drain-marker-crash-not-shutdown";
        let input = format!("Fatal error: {marker}\n  |0x1\n  |0x2\n  |0x3\n");
        let got = drain(&input, false).await;
        let matching: Vec<_> = got.into_iter().filter(|(_, m)| m.contains(marker)).collect();
        // The "Fatal error: …" line itself is logged normally (Info: it has
        // no WARN/ERROR level word), *and* the crash summary quotes it.
        assert_eq!(
            matching,
            vec![
                (log::Level::Info, format!("Fatal error: {marker}")),
                (log::Level::Error, format!("signal-cli crashed (3 crash-dump lines collapsed): Fatal error: {marker}")),
            ]
        );
    }

    #[tokio::test]
    async fn a_crash_dump_during_shutdown_is_one_harmless_info_line() {
        let marker = "drain-marker-crash-during-shutdown";
        let input = format!("Fatal error: {marker}\n  |0x1\n  |0x2\n");
        let got = drain(&input, true).await;
        let crash_summary: Vec<_> =
            got.into_iter().filter(|(_, m)| m.contains("GraalVM native-image teardown")).collect();
        assert_eq!(
            crash_summary,
            vec![(
                log::Level::Info,
                "signal-cli crashed while shutting down (known GraalVM native-image teardown bug; harmless)"
                    .to_string()
            )]
        );
    }
}
