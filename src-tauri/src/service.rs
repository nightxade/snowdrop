//! The signal-cli connection the UI drives through Tauri commands: one
//! active backend at a time (the managed child, or an external daemon),
//! subscriptions per account, and the held-event log behind resume cursors.
//! Independent of Tauri (events go to an `EventSink`), so it's testable with
//! the fake signal-cli.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::{self, BinarySource, ConnectConfig, ResolvedBinary};
use crate::error::{Error, ErrorKind};
use crate::events::{EventLog, HeldEvent};
use crate::external::{ExternalDaemon, StreamUpdate, CURSOR_PREFIX};
use crate::jsonrpc::receive_payload;
use crate::process::{Backoff, ProcessOptions, ProcessState, RpcProcess};
use crate::startup::{self, LastConnect, LastConnectFile};
use crate::vault_bridge::{self, VaultBridge};

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
    /// The signal-cli vault (docs/ENCRYPTION.md, "signal-cli vault"; task
    /// 4b): where to spawn a managed child's `--config` dir, sync triggers,
    /// on-demand media, and the vault half of shutdown. A no-op pass-through
    /// when the vault is disabled ([`VaultBridge::disabled`]).
    vault: Arc<VaultBridge>,
    /// What the last successful spawn-mode connect left behind, so the next
    /// launch can start signal-cli ahead of the webview ([`prespawn`](Self::prespawn)).
    last: LastConnectFile,
    /// Set by the first pre-spawn attempt that gets as far as trying.
    prespawn_tried: AtomicBool,
    /// Set by [`stop_backend`](Self::stop_backend) (erase, sign-out, quit):
    /// nothing may pre-spawn after that.
    retired: AtomicBool,
}

/// What [`Service::prespawn`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prespawn {
    /// Nothing to do: no linked account on record, storage not open, already
    /// attempted, or something else is already running.
    Skipped,
    Started,
    /// signal-cli didn't come up; the frontend's own connect reports it.
    Failed,
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
    pub fn new(paths: Paths, sink: Arc<dyn EventSink>, vault: Arc<VaultBridge>) -> Arc<Self> {
        Self::with_timeouts(paths, sink, Timeouts::default(), vault)
    }

    pub fn with_timeouts(paths: Paths, sink: Arc<dyn EventSink>, timeouts: Timeouts, vault: Arc<VaultBridge>) -> Arc<Self> {
        let paths_app_data_dir = paths.app_data_dir.clone();
        Arc::new_cyclic(|me| Self {
            paths,
            sink,
            log: Mutex::new(EventLog::new(new_run_id())),
            subs: Mutex::new(Subscriptions::default()),
            active: tokio::sync::Mutex::new(None),
            me: me.clone(),
            timeouts,
            vault,
            last: LastConnectFile::new(&paths_app_data_dir),
            prespawn_tried: AtomicBool::new(false),
            retired: AtomicBool::new(false),
        })
    }

    pub fn run_id(&self) -> String {
        self.log.lock().expect("log lock").run().to_owned()
    }

    pub fn bundled(&self) -> Option<&PathBuf> {
        self.paths.bundled.as_ref()
    }

    /// Whether the active backend (if any) is an external daemon rather than
    /// a managed child — used for `StorageStatus::vault_disabled`
    /// (docs/ENCRYPTION.md: external-daemon mode is explicitly "not covered"
    /// by the vault; the user owns that data themselves). A `try_lock` that
    /// doesn't succeed (a connect/disconnect briefly in flight) reads as
    /// "not external", which only means the flag can lag by the instant of
    /// that one call — never worth blocking a status read over.
    pub fn is_external_active(&self) -> bool {
        self.active.try_lock().map(|g| matches!(&*g, Some(Active::External { .. }))).unwrap_or(false)
    }

    pub fn locate(&self, binary_path: Option<&str>) -> Result<ResolvedBinary, Error> {
        let patched = config::patched_binary(&self.paths.app_data_dir);
        let downloaded = crate::signal_cli_install::installed_binary(&self.paths.app_data_dir);
        config::resolve_binary(
            binary_path,
            patched.as_deref(),
            downloaded.as_deref(),
            self.paths.bundled.as_deref(),
            std::env::var_os("PATH").as_deref(),
        )
    }

    /// Starts (or keeps) the backend for `config` and checks it answers.
    ///
    /// This holds `active` across `start()`, which (through the vault
    /// bridge) briefly locks `storage::StorageService`'s own mutex to
    /// resolve the spawn dir. Reviewed whether that's safe to avoid by
    /// resolving the spawn dir before taking `active`: it isn't, without a
    /// second lock to replace what `active` currently buys this
    /// function — single-flight (only one `connect` ever spawns at a time)
    /// and `request`/`subscribe` blocking until a reconnect in progress
    /// finishes rather than seeing a momentary gap. Left as-is; the actual
    /// deadlock is fixed on the other side (storage.rs's `begin_erase`/
    /// `finish_erase`, `begin_sign_out`/`finish_sign_out`), which never lets
    /// the erase/sign-out hooks hold storage's lock while they call back
    /// into `stop_backend` for `active` — so this lock is only ever briefly
    /// contended, never cyclically.
    pub async fn connect(&self, config: ConnectConfig) -> Result<ConnectInfo, Error> {
        startup::mark_once("signal-cli connect requested");
        let result = self.connect_inner(config.clone()).await;
        if result.is_ok() {
            self.note_connected(&config);
            startup::mark_once("signal-cli connect done");
        }
        result
    }

    async fn connect_inner(&self, config: ConnectConfig) -> Result<ConnectInfo, Error> {
        // Also what a pre-spawn in progress holds: a connect arriving
        // meanwhile waits here, then reuses its child if the config matches.
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

    /// Forces a fresh backend for `config`, even if the current one is still
    /// answering requests — unlike [`connect`](Self::connect), never reuses
    /// it. For a managed child, this is the only way to make signal-cli
    /// re-run its own startup account-loading: `MultiAccountManager` builds
    /// itself once per process and never retries an account a transient
    /// hiccup made it drop, so recovering means a new process (see
    /// `SignalCliBackend`'s `account-unavailable` recovery on the TS side).
    pub async fn restart(&self, config: ConnectConfig) -> Result<ConnectInfo, Error> {
        let mut active = self.active.lock().await;
        if let Some(old) = active.take() {
            self.stop_active(old).await;
        }
        let started = self.start(config.clone()).await?;
        let info = self.info(&started);
        *active = Some(started);
        drop(active);
        self.note_connected(&config);
        Ok(info)
    }

    /// Records a successful connect for the next launch's pre-spawn.
    fn note_connected(&self, config: &ConnectConfig) {
        match LastConnect::after_connect(self.last.load().as_ref(), config) {
            Some(record) => self.last.save(&record),
            None => self.last.clear(),
        }
    }

    /// A `listAccounts` reply from the managed child says whether an account
    /// is linked; only a linked one makes the record worth pre-spawning for.
    fn note_accounts(&self, config: &ConnectConfig, reply: &Value) {
        let Some(count) = count_accounts(reply.clone()) else { return };
        if let Some(mut record) = LastConnect::after_connect(self.last.load().as_ref(), config) {
            record.linked = count > 0;
            self.last.save(&record);
        }
    }

    /// Forgets the last connection (erase, sign-out): the next launch has
    /// nothing to pre-spawn for.
    pub fn forget_last_connect(&self) {
        self.last.clear();
    }

    /// Starts signal-cli ahead of the frontend's own `connect`, with the
    /// config the last successful spawn-mode connect used — the frontend's
    /// connect then finds it running and reuses it (equal config), which
    /// takes the JVM start out of the boot's critical path.
    ///
    /// Only when an account was linked last time and storage is open (or the
    /// vault is disabled) — never for an external daemon, onboarding, or a
    /// locked/unset storage; the unlock commands call this again once storage
    /// opens. One attempt per process. Single-flight with `connect`/`restart`:
    /// it holds `active` for the whole start, so a connect arriving
    /// mid-pre-spawn waits for it, and a different config replaces it as it
    /// would any child. A failure is logged (kind only) and otherwise silent:
    /// the frontend's connect starts from scratch and reports errors itself.
    pub async fn prespawn(&self) -> Prespawn {
        if self.retired.load(Ordering::SeqCst) {
            return Prespawn::Skipped;
        }
        let Some(config) = self.last.load().and_then(|last| last.prespawn_config()) else {
            return Prespawn::Skipped;
        };
        if !self.vault.ready_to_spawn() || self.prespawn_tried.swap(true, Ordering::SeqCst) {
            return Prespawn::Skipped;
        }
        let mut active = self.active.lock().await;
        // Erase/sign-out/quit may have stopped the backend while this waited.
        if self.retired.load(Ordering::SeqCst) || active.is_some() {
            return Prespawn::Skipped;
        }
        match self.start(config).await {
            Ok(started) => {
                *active = Some(started);
                Prespawn::Started
            }
            Err(e) => {
                log::info!(target: "rust:startup", "pre-spawn didn't come up ({:?})", e.kind);
                Prespawn::Failed
            }
        }
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
                // The vault's RAM-backed runtime dir once storage is unlocked
                // and the vault applies, or `paths.data_dir` unchanged when
                // it's disabled (docs/ENCRYPTION.md, "signal-cli vault").
                let config_dir = self.vault.spawn_config_dir(&self.paths.data_dir)?;
                startup::mark_once("storage restored");
                std::fs::create_dir_all(&config_dir)
                    .map_err(|e| Error::new(ErrorKind::Internal, format!("Couldn't create {}: {e}", config_dir.display())))?;
                // Keys and message history live here; no other local account should read them.
                config::secure_dir(&config_dir)?;
                let options = ProcessOptions {
                    program: binary.path.clone(),
                    args: config::spawn_args(&config_dir, account.as_deref()),
                    envs: config::spawn_env(std::env::var_os("MALLOC_ARENA_MAX").as_deref()),
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
                startup::mark_once("signal-cli spawned");
                process.wait_running(self.timeouts.start).await?;
                // signal-cli answers once it has loaded its accounts.
                let reply = process.request("version", None, self.timeouts.first_answer).await?;
                startup::mark_once("signal-cli answering");
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

    /// Stops the active backend (if any) without touching the vault — the
    /// half of shutdown the storage erase hook needs
    /// (docs/ENCRYPTION.md, "Erase": stop signal-cli, but the vault must
    /// never sync as part of an erase). [`shutdown`](Self::shutdown) is this
    /// plus the vault's own stop, in that order.
    pub async fn stop_backend(&self) {
        // Before taking `active`, so a pre-spawn waiting on it gives up
        // instead of starting a child right after this stopped the last one.
        self.retired.store(true, Ordering::SeqCst);
        let active = self.active.lock().await.take();
        if let Some(active) = active {
            self.stop_active(active).await;
        }
    }

    /// Stops everything (app exit): signal-cli first, waited for, then the
    /// vault's final sync and wipe (docs/ENCRYPTION.md, "signal-cli vault",
    /// "When to sync": "On shutdown, while still blocking exit").
    pub async fn shutdown(&self) {
        self.stop_backend().await;
        self.vault.shutdown().await;
    }

    pub async fn request(&self, method: &str, params: Option<Map<String, Value>>, timeout: Duration) -> Result<Value, Error> {
        if RESERVED.contains(&method) {
            return Err(Error::new(ErrorKind::Config, format!("{method} is managed by Snowdrop.")));
        }
        // Before forwarding: hydrate the attachment into the runtime dir if
        // the vault has it but the runtime copy was evicted or never
        // restored (docs/ENCRYPTION.md, "Attachment budget").
        if method == "getAttachment" {
            if let Some(id) = params.as_ref().and_then(|p| p.get("id")).and_then(Value::as_str).map(str::to_owned) {
                let vault = self.vault.clone();
                tokio::task::spawn_blocking(move || vault.ensure_attachment(&id))
                    .await
                    .unwrap_or_else(|e| Err(Error::new(ErrorKind::Internal, format!("vault: attachment hydration task failed: {e}"))))?;
            }
        }
        let active = self.active.lock().await;
        let result = match active.as_ref() {
            None => Err(Error::new(ErrorKind::Unreachable, "signal-cli isn't connected yet.")),
            Some(Active::Child { process, config, .. }) => {
                let process = process.clone();
                let config = config.clone();
                drop(active);
                let result = process.request(method, params.as_ref(), timeout).await;
                if method == "listAccounts" {
                    if let Ok(reply) = &result {
                        self.note_accounts(&config, reply);
                    }
                }
                result
            }
            Some(Active::External { daemon, .. }) => {
                let daemon = daemon.clone();
                drop(active);
                let method_owned = method.to_owned();
                blocking(move || daemon.request(&method_owned, params.as_ref(), timeout)).await
            }
        };
        // After a successful send*/updateGroup/updateContact/finishLink:
        // mark the vault dirty (docs/ENCRYPTION.md, "When to sync"). A no-op
        // when the vault is disabled or no session has been built yet.
        if let Ok(reply) = &result {
            if reply.get("error").is_none() && vault_bridge::triggers_sync(method) {
                self.vault.trigger();
            }
        }
        result
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
        // Mark the vault dirty (docs/ENCRYPTION.md, "When to sync": "about
        // 2s, debounced, after a receive batch is acknowledged").
        self.vault.trigger();
    }

    /// `receive` carries the envelope; `receiveCaughtUp` (patches/signal-cli
    /// 0012) tells the UI the receive loop drained the server's queue, and
    /// `receiveCatchingUp` (0025) that it started to fill, both with no
    /// envelope. They all wrap their payload in `{ subscription, result }` the
    /// same way (`subscribe_child` subscribes to both at once), so they share
    /// the account lookup and the held-event log; only the forwarded `kind`
    /// (and therefore the UI's event `type`) differs.
    fn on_notification(&self, method: &str, params: Value) {
        if !matches!(method, "receive" | "receiveCaughtUp" | "receiveCatchingUp" | "receiveConfigurationChanged" | "attachmentBackfill") {
            log::debug!("ignored signal-cli notification {method}");
            return;
        }
        let subscription = params.get("subscription").and_then(Value::as_u64);
        let account = {
            let subs = self.subs.lock().expect("subs lock");
            match subscription.and_then(|id| subs.by_id.get(&id)) {
                Some(account) => account.clone(),
                // An unwrapped notification (automatic receiving) or a subscription we
                // lost track of: only safe to guess the account when there's just one.
                None if subs.accounts.len() == 1 => subs.accounts[0].clone(),
                None => {
                    log::warn!(
                        "dropped a {method} notification with an unrecognised subscription id ({} account(s) subscribed)",
                        subs.accounts.len()
                    );
                    return;
                }
            }
        };
        let payload = receive_payload(params);
        let event = self.log.lock().expect("log lock").push(&account, method, payload);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeSink {
        events: Mutex<Vec<HeldEvent>>,
        states: Mutex<Vec<StreamState>>,
    }

    impl EventSink for FakeSink {
        fn event(&self, event: &HeldEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
        fn state(&self, state: &StreamState) {
            self.states.lock().unwrap().push(state.clone());
        }
    }

    fn service_with_sink() -> (Arc<Service>, Arc<FakeSink>) {
        let sink = Arc::new(FakeSink::default());
        let svc = Service::new(
            Paths { app_data_dir: PathBuf::new(), data_dir: PathBuf::new(), bundled: None },
            sink.clone(),
            VaultBridge::disabled(),
        );
        (svc, sink)
    }

    /// A single subscribed account is still a safe guess for a notification
    /// whose subscription id doesn't match anything Snowdrop tracked (e.g. an
    /// unwrapped notification from automatic receiving).
    #[test]
    fn unrecognised_subscription_falls_back_to_the_lone_subscribed_account() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().accounts.push("+15550001".into());

        svc.on_notification("receive", json!({"subscription": 999, "envelope": {"dataMessage": {"message": "hi"}}}));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account, "+15550001");
    }

    /// With more than one account subscribed, guessing which one an
    /// unrecognised subscription belongs to would misattribute someone else's
    /// message, so the notification is dropped instead.
    #[test]
    fn unrecognised_subscription_is_dropped_with_multiple_accounts_subscribed() {
        let (svc, sink) = service_with_sink();
        {
            let mut subs = svc.subs.lock().unwrap();
            subs.accounts.push("+15550001".into());
            subs.accounts.push("+15550002".into());
        }

        svc.on_notification("receive", json!({"subscription": 999, "envelope": {"dataMessage": {"message": "hi"}}}));

        assert!(sink.events.lock().unwrap().is_empty());
    }

    /// Same when no account has subscribed yet at all.
    #[test]
    fn unrecognised_subscription_is_dropped_with_no_accounts_subscribed() {
        let (svc, sink) = service_with_sink();

        svc.on_notification("receive", json!({"subscription": 999, "envelope": {}}));

        assert!(sink.events.lock().unwrap().is_empty());
    }

    /// `receiveCaughtUp` (patches/signal-cli 0012) is forwarded just like `receive`,
    /// with its own `kind` and no envelope, using the same account lookup.
    #[test]
    fn caught_up_notification_is_forwarded_with_its_own_kind() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().by_id.insert(0, "+15550001".into());

        svc.on_notification("receiveCaughtUp", json!({"subscription": 0, "result": {"account": "+15550001"}}));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "receiveCaughtUp");
        assert_eq!(events[0].account, "+15550001");
        assert_eq!(events[0].data, json!({"account": "+15550001"}));
    }

    /// `receiveCatchingUp` (patches/signal-cli 0025) is forwarded the same way:
    /// without it in the allow-list the UI would never hear a drain started.
    #[test]
    fn catching_up_notification_is_forwarded_with_its_own_kind() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().by_id.insert(0, "+15550001".into());

        svc.on_notification("receiveCatchingUp", json!({"subscription": 0, "result": {"account": "+15550001"}}));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "receiveCatchingUp");
        assert_eq!(events[0].account, "+15550001");
        assert_eq!(events[0].data, json!({"account": "+15550001"}));
    }

    /// `receiveConfigurationChanged` (patches/signal-cli 0022) is forwarded the
    /// same way: no values, the UI re-reads `getConfiguration`.
    #[test]
    fn configuration_changed_notification_is_forwarded_with_its_own_kind() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().by_id.insert(0, "+15550001".into());

        svc.on_notification("receiveConfigurationChanged", json!({"subscription": 0, "result": {"account": "+15550001"}}));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "receiveConfigurationChanged");
        assert_eq!(events[0].account, "+15550001");
    }

    /// `attachmentBackfill` (patches/signal-cli 0016) — our primary answered a
    /// `requestAttachmentBackfill` — is forwarded with its result as the data,
    /// or "get it from your phone" never hears back.
    #[test]
    fn attachment_backfill_notification_is_forwarded_with_its_result() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().by_id.insert(0, "+15550001".into());
        let result = json!({"targetAuthor": "a", "targetTimestamp": 5, "status": "ready", "attachmentIds": ["x"]});

        svc.on_notification("attachmentBackfill", json!({"subscription": 0, "result": result.clone()}));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "attachmentBackfill");
        assert_eq!(events[0].account, "+15550001");
        assert_eq!(events[0].data, result);
    }

    /// A notification method Snowdrop doesn't understand is dropped, not forwarded
    /// under some made-up kind.
    #[test]
    fn unknown_notification_method_is_ignored() {
        let (svc, sink) = service_with_sink();
        svc.subs.lock().unwrap().accounts.push("+15550001".into());

        svc.on_notification("somethingElse", json!({"subscription": 0}));

        assert!(sink.events.lock().unwrap().is_empty());
    }
}
