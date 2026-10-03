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
use crate::logfile::LogFile;

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
    /// Where signal-cli's stderr goes (None: discarded).
    pub log: Option<PathBuf>,
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
    let log = options.log.clone().map(LogFile::new);
    loop {
        if *shutdown.borrow() {
            break;
        }
        shared.set_state(ProcessState::Starting { attempt });
        let mut command = Command::new(&options.program);
        command
            .args(&options.args)
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
        let drain = tokio::spawn(drain_stderr(stderr, log.clone()));
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
            Err(_) => log::warn!("unexpected output from signal-cli: {}", truncate(&line, 200)),
        }
    }
}

async fn drain_stderr(stderr: impl AsyncRead + Unpin, log: Option<LogFile>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match &log {
            Some(log) => log.append(&line),
            None => log::debug!("signal-cli: {}", truncate(&line, 500)),
        }
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
}
