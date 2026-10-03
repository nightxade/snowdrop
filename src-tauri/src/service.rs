//! The signal-cli connection the UI drives through Tauri commands: one
//! active backend at a time (the managed child, or an external daemon),
//! subscriptions per account, and the held-event log behind resume cursors.
//! Independent of Tauri (events go to an `EventSink`), so it's testable with
//! the fake signal-cli.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::{self, BinarySource, ConnectConfig, ResolvedBinary};
use crate::error::{Error, ErrorKind};
use crate::events::{EventLog, HeldEvent};
use crate::external::{ExternalDaemon, StreamUpdate, CURSOR_PREFIX};
use crate::jsonrpc::receive_payload;
use crate::process::{Backoff, ProcessOptions, ProcessState, RpcProcess};

/// Where incoming events and stream state go (the webview, or a test).
pub trait EventSink: Send + Sync {
    fn event(&self, event: &HeldEvent);
    fn state(&self, state: &StreamState);
}

/// The event stream's state, as the UI's `EventStreamState` expects it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamState {
    Connecting { attempt: u32 },
    Open,
    #[serde(rename_all = "camelCase")]
    Waiting { attempt: u32, delay_ms: u64, reason: String },
    #[serde(rename_all = "camelCase")]
    Failed { error_kind: ErrorKind, message: String },
    Closed,
}

#[derive(Debug, Clone)]
pub struct Paths {
    /// The Tauri app data dir itself (where a downloaded signal-cli lives,
    /// under `signal-cli/<version>/`; see `signal_cli_install`).
    pub app_data_dir: PathBuf,
    /// signal-cli's data directory for the managed child (`--config`).
    pub data_dir: PathBuf,
    /// signal-cli's stderr.
    pub log_file: Option<PathBuf>,
    /// The bundled sidecar, if this build has one (`bundled-sidecar` feature only).
    pub bundled: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub mode: &'static str,
    pub binary: Option<ResolvedBinary>,
    pub version: Option<String>,
    /// Cursors from this run start with it.
    pub run: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub accounts: Option<usize>,
    pub version: Option<String>,
    pub binary: Option<ResolvedBinary>,
}

enum Active {
    Child {
        config: ConnectConfig,
        process: Arc<RpcProcess>,
        binary: ResolvedBinary,
        version: Option<String>,
    },
    External {
        config: ConnectConfig,
        daemon: ExternalDaemon,
    },
}

#[derive(Default)]
struct Subscriptions {
    /// Accounts the UI subscribed ("" = single-account), for re-subscribing after a restart.
    accounts: Vec<String>,
    /// signal-cli subscription id → account, for the current child.
    by_id: HashMap<u64, String>,
    /// External mode: a stop flag per account's SSE thread.
    streams: HashMap<String, Arc<AtomicBool>>,
}

pub struct Service {
    paths: Paths,
    sink: Arc<dyn EventSink>,
    log: Mutex<EventLog>,
    subs: Mutex<Subscriptions>,
    active: tokio::sync::Mutex<Option<Active>>,
    me: Weak<Service>,
    timeouts: Timeouts,
}

#[derive(Debug, Clone)]
pub struct Timeouts {
    pub start: Duration,
    pub first_answer: Duration,
    pub backoff: Backoff,
    pub grace: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            start: Duration::from_secs(15),
            first_answer: Duration::from_secs(60),
            backoff: Backoff::default(),
            grace: Duration::from_secs(5),
        }
    }
}

const RESERVED: [&str; 2] = ["subscribeReceive", "unsubscribeReceive"];

fn new_run_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}

impl Service {
    pub fn new(paths: Paths, sink: Arc<dyn EventSink>) -> Arc<Self> {
        Self::with_timeouts(paths, sink, Timeouts::default())
    }

    pub fn with_timeouts(paths: Paths, sink: Arc<dyn EventSink>, timeouts: Timeouts) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            paths,
            sink,
            log: Mutex::new(EventLog::new(new_run_id())),
            subs: Mutex::new(Subscriptions::default()),
            active: tokio::sync::Mutex::new(None),
            me: me.clone(),
            timeouts,
        })
    }

    pub fn run_id(&self) -> String {
        self.log.lock().expect("log lock").run().to_owned()
    }

    pub fn bundled(&self) -> Option<&PathBuf> {
        self.paths.bundled.as_ref()
    }

    pub fn locate(&self, binary_path: Option<&str>) -> Result<ResolvedBinary, Error> {
        let downloaded = crate::signal_cli_install::installed_binary(&self.paths.app_data_dir);
        config::resolve_binary(
            binary_path,
            downloaded.as_deref(),
            self.paths.bundled.as_deref(),
            std::env::var_os("PATH").as_deref(),
        )
    }

    /// Starts (or keeps) the backend for `config` and checks it answers.
    pub async fn connect(&self, config: ConnectConfig) -> Result<ConnectInfo, Error> {
        let mut active = self.active.lock().await;
        if let Some(current) = active.as_ref() {
            let reusable = match current {
                Active::Child { config: c, process, .. } => {
                    *c == config && !matches!(process.state(), ProcessState::Failed { .. } | ProcessState::Stopped)
                }
                Active::External { config: c, .. } => *c == config,
            };
            if reusable {
                return self.check_active(current).await.map(|()| self.info(current));
            }
        }
        if let Some(old) = active.take() {
            self.stop_active(old).await;
        }
        let started = self.start(config).await?;
        let info = self.info(&started);
        *active = Some(started);
        Ok(info)
    }

    fn info(&self, active: &Active) -> ConnectInfo {
        match active {
            Active::Child { binary, version, .. } => ConnectInfo {
                mode: "spawn",
                binary: Some(binary.clone()),
                version: version.clone(),
                run: self.run_id(),
            },
            Active::External { .. } => ConnectInfo { mode: "external", binary: None, version: None, run: self.run_id() },
        }
    }

    async fn check_active(&self, active: &Active) -> Result<(), Error> {
        match active {
            Active::Child { process, .. } => process.wait_running(self.timeouts.start).await.map(|_| ()),
            Active::External { daemon, .. } => {
                let daemon = daemon.clone();
                blocking(move || daemon.check(Duration::from_secs(5))).await
            }
        }
    }

    async fn start(&self, config: ConnectConfig) -> Result<Active, Error> {
        match &config {
            ConnectConfig::Spawn { binary_path, account } => {
                let account = account.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(config::validate_account).transpose()?;
                let binary = self.locate(binary_path.as_deref())?;
                std::fs::create_dir_all(&self.paths.data_dir).map_err(|e| {
                    Error::new(ErrorKind::Internal, format!("Couldn't create {}: {e}", self.paths.data_dir.display()))
                })?;
                let options = ProcessOptions {
                    program: binary.path.clone(),
                    args: config::spawn_args(&self.paths.data_dir, account.as_deref()),
                    log: self.paths.log_file.clone(),
                    backoff: self.timeouts.backoff.clone(),
                    grace: self.timeouts.grace,
                };
                let me = self.me.clone();
                let on_notification = Arc::new(move |method: String, params: Value| {
                    if let Some(me) = me.upgrade() {
                        me.on_notification(&method, params);
                    }
                });
                let me = self.me.clone();
                let on_state = Arc::new(move |state: &ProcessState| {
                    if let Some(me) = me.upgrade() {
                        me.on_process_state(state);
                    }
                });
                let process = Arc::new(RpcProcess::start(options, on_notification, on_state));
                process.wait_running(self.timeouts.start).await?;
                // signal-cli answers once it has loaded its accounts.
                let reply = process.request("version", None, self.timeouts.first_answer).await?;
                let version = reply.pointer("/result/version").and_then(Value::as_str).map(str::to_owned);
                log::info!("signal-cli {} running from {} ({:?})", version.as_deref().unwrap_or("?"), binary.path.display(), binary.source);
                Ok(Active::Child { config, process, binary, version })
            }
            ConnectConfig::External { url } => {
                let url = config::validate_daemon_url(url)?;
                let daemon = ExternalDaemon::new(&url);
                let probe = daemon.clone();
                blocking(move || probe.check(Duration::from_secs(5))).await?;
                Ok(Active::External { config, daemon })
            }
        }
    }

    async fn stop_active(&self, active: Active) {
        {
            let mut subs = self.subs.lock().expect("subs lock");
            subs.by_id.clear();
            for (_, stop) in subs.streams.drain() {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        if let Active::Child { process, .. } = active {
            process.shutdown().await;
        }
    }

    /// Stops everything (app exit).
    pub async fn shutdown(&self) {
        let active = self.active.lock().await.take();
        if let Some(active) = active {
            self.stop_active(active).await;
        }
    }

    pub async fn request(&self, method: &str, params: Option<Map<String, Value>>, timeout: Duration) -> Result<Value, Error> {
        if RESERVED.contains(&method) {
            return Err(Error::new(ErrorKind::Config, format!("{method} is managed by Snowdrop.")));
        }
        let active = self.active.lock().await;
        match active.as_ref() {
            None => Err(Error::new(ErrorKind::Unreachable, "signal-cli isn't connected yet.")),
            Some(Active::Child { process, .. }) => {
                let process = process.clone();
                drop(active);
                process.request(method, params.as_ref(), timeout).await
            }
            Some(Active::External { daemon, .. }) => {
                let daemon = daemon.clone();
                drop(active);
                let method = method.to_owned();
                blocking(move || daemon.request(&method, params.as_ref(), timeout)).await
            }
        }
    }

    /// Starts receiving for `account` (None: single-account signal-cli),
    /// replaying held events after `resume_from` first.
    pub async fn subscribe(&self, account: Option<String>, resume_from: String) -> Result<String, Error> {
        let key = account.clone().unwrap_or_default();
        let active = self.active.lock().await;
        match active.as_ref() {
            None => Err(Error::new(ErrorKind::Unreachable, "signal-cli isn't connected yet.")),
            Some(Active::Child { process, .. }) => {
                let process = process.clone();
                drop(active);
                // Replay under the log lock, so nothing new interleaves with it.
                {
                    let log = self.log.lock().expect("log lock");
                    let same_run = resume_from.rsplit_once(':').is_some_and(|(run, _)| run == log.run());
                    let replay = if same_run { log.replay_after(&key, &resume_from) } else { log.held_for(&key) };
                    for event in &replay {
                        self.sink.event(event);
                    }
                }
                let already = {
                    let mut subs = self.subs.lock().expect("subs lock");
                    if !subs.accounts.contains(&key) {
                        subs.accounts.push(key.clone());
                    }
                    subs.by_id.values().any(|a| *a == key)
                };
                if !already {
                    self.subscribe_child(&process, &key).await?;
                }
                self.sink.state(&StreamState::Open);
                Ok(self.run_id())
            }
            Some(Active::External { daemon, .. }) => {
                let daemon = daemon.clone();
                drop(active);
                let stop = Arc::new(AtomicBool::new(false));
                if let Some(previous) = self.subs.lock().expect("subs lock").streams.insert(key.clone(), stop.clone()) {
                    previous.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                let resume = resume_from.strip_prefix(CURSOR_PREFIX).map(str::to_owned);
                let sink = self.sink.clone();
                let account_key = key.clone();
                self.sink.state(&StreamState::Connecting { attempt: 0 });
                daemon.subscribe(account, resume, stop, move |update| match update {
                    StreamUpdate::Open => sink.state(&StreamState::Open),
                    StreamUpdate::Event { kind, data, cursor } => sink.event(&HeldEvent {
                        cursor: cursor.unwrap_or_default(),
                        account: account_key.clone(),
                        kind,
                        data,
                    }),
                    StreamUpdate::Waiting { attempt, delay, reason } => sink.state(&StreamState::Waiting {
                        attempt,
                        delay_ms: delay.as_millis() as u64,
                        reason,
                    }),
                    StreamUpdate::Failed { message } => {
                        sink.state(&StreamState::Failed { error_kind: ErrorKind::Unreachable, message })
                    }
                });
                Ok(self.run_id())
            }
        }
    }

    async fn subscribe_child(&self, process: &RpcProcess, key: &str) -> Result<(), Error> {
        let mut params = Map::new();
        if !key.is_empty() {
            params.insert("account".into(), json!(key));
        }
        let reply = process.request("subscribeReceive", Some(&params), Duration::from_secs(30)).await?;
        let id = reply.get("result").and_then(Value::as_u64).ok_or_else(|| {
            let message = reply.pointer("/error/message").and_then(Value::as_str).unwrap_or("no subscription id");
            Error::new(ErrorKind::InvalidResponse, format!("subscribeReceive failed: {message}"))
        })?;
        self.subs.lock().expect("subs lock").by_id.insert(id, key.to_owned());
        Ok(())
    }

    /// The UI stored everything up to `cursor`.
    pub fn acknowledge(&self, cursor: &str) {
        self.log.lock().expect("log lock").acknowledge(cursor);
    }

    fn on_notification(&self, method: &str, params: Value) {
        if method != "receive" {
            log::debug!("ignored signal-cli notification {method}");
            return;
        }
        let subscription = params.get("subscription").and_then(Value::as_u64);
        let account = {
            let subs = self.subs.lock().expect("subs lock");
            match subscription.and_then(|id| subs.by_id.get(&id)) {
                Some(account) => account.clone(),
                // An unwrapped notification (automatic receiving) or a subscription we lost track of.
                None => subs.accounts.first().cloned().unwrap_or_default(),
            }
        };
        let payload = receive_payload(params);
        let event = self.log.lock().expect("log lock").push(&account, "receive", payload);
        self.sink.event(&event);
    }

    fn on_process_state(&self, state: &ProcessState) {
        let stream = match state {
            ProcessState::Starting { attempt } => StreamState::Connecting { attempt: *attempt },
            ProcessState::Running { generation } => {
                if *generation > 1 {
                    // A restarted child has no subscriptions: renew them.
                    self.resubscribe();
                }
                return;
            }
            ProcessState::Restarting { attempt, delay_ms, reason } => {
                self.subs.lock().expect("subs lock").by_id.clear();
                StreamState::Waiting { attempt: *attempt, delay_ms: *delay_ms, reason: reason.clone() }
            }
            ProcessState::Failed { kind, message } => StreamState::Failed { error_kind: *kind, message: message.clone() },
            ProcessState::Stopped => StreamState::Closed,
        };
        self.sink.state(&stream);
    }

    fn resubscribe(&self) {
        let Some(me) = self.me.upgrade() else { return };
        tokio::spawn(async move {
            let process = match me.active.lock().await.as_ref() {
                Some(Active::Child { process, .. }) => process.clone(),
                _ => return,
            };
            let accounts = me.subs.lock().expect("subs lock").accounts.clone();
            for key in accounts {
                if let Err(error) = me.subscribe_child(&process, &key).await {
                    log::warn!("couldn't renew the subscription after a restart: {error}");
                    me.sink.state(&StreamState::Waiting { attempt: 0, delay_ms: 1000, reason: error.message });
                    return;
                }
            }
            me.sink.state(&StreamState::Open);
        });
    }

    /// Checks a configuration without disturbing the running one.
    pub async fn probe(&self, config: ConnectConfig) -> Result<ProbeResult, Error> {
        match config {
            ConnectConfig::Spawn { binary_path, account } => {
                if let Some(account) = account.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
                    config::validate_account(account)?;
                }
                let binary = self.locate(binary_path.as_deref())?;
                let version = binary_version(&binary).await?;
                // Accounts are only known from a running child with this binary
                // (a second signal-cli on the same data would wait for its lock).
                let running = match self.active.lock().await.as_ref() {
                    Some(Active::Child { process, binary: b, .. }) if b.path == binary.path => Some(process.clone()),
                    _ => None,
                };
                let accounts = match running {
                    Some(process) => count_accounts(process.request("listAccounts", None, Duration::from_secs(10)).await?),
                    None => None,
                };
                Ok(ProbeResult { accounts, version: Some(version), binary: Some(binary) })
            }
            ConnectConfig::External { url } => {
                let url = config::validate_daemon_url(&url)?;
                let daemon = ExternalDaemon::new(&url);
                let accounts = blocking(move || {
                    daemon.check(Duration::from_secs(5))?;
                    daemon.request("listAccounts", None, Duration::from_secs(5))
                })
                .await?;
                Ok(ProbeResult { accounts: count_accounts(accounts), version: None, binary: None })
            }
        }
    }
}

fn count_accounts(reply: Value) -> Option<usize> {
    reply.get("result").and_then(Value::as_array).map(Vec::len)
}

/// `<signal-cli> --version` (fixed argument), e.g. "signal-cli 0.14.8" → "0.14.8".
async fn binary_version(binary: &ResolvedBinary) -> Result<String, Error> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(&binary.path).arg("--version").kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| Error::new(ErrorKind::Timeout, "signal-cli --version didn't finish in time."))?
    .map_err(|e| Error::new(ErrorKind::NotInstalled, format!("Couldn't run {}: {e}", binary.path.display())))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim().strip_prefix("signal-cli").map(str::trim).filter(|v| !v.is_empty());
    match (output.status.success(), version) {
        (true, Some(v)) => Ok(v.to_owned()),
        _ => Err(Error::new(
            ErrorKind::Config,
            format!(
                "{} doesn't look like signal-cli{}.",
                binary.path.display(),
                if binary.source == BinarySource::Bundled { " (the bundled copy is damaged; reinstall Snowdrop)" } else { "" }
            ),
        )),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(Error::new(ErrorKind::Internal, format!("background task failed: {e}"))))
}
