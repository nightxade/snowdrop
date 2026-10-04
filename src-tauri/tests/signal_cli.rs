//! The child-process manager and the service against the fake signal-cli
//! (scripts/fake-signal-cli/signal-cli, a Node script speaking jsonRpc on
//! stdio), and external-daemon mode against a tiny in-process HTTP daemon.
//! Tests that need the fake are skipped when `node` isn't installed.

use serde_json::{json, Value};
use snowdrop_lib::config::ConnectConfig;
use snowdrop_lib::error::ErrorKind;
use snowdrop_lib::events::HeldEvent;
use snowdrop_lib::process::{Backoff, ProcessOptions, ProcessState, RpcProcess};
use snowdrop_lib::service::{EventSink, Paths, Service, StreamState, Timeouts};
use snowdrop_lib::vault_bridge::VaultBridge;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fake() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-signal-cli/signal-cli").canonicalize().unwrap()
}

fn have_node() -> bool {
    std::process::Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

macro_rules! require_node {
    () => {
        if !have_node() {
            eprintln!("skipped: node isn't installed");
            return;
        }
    };
}

/// Inside the target directory (never signal-cli's real data in ~/.local/share).
fn temp_dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("snowdrop-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fast_backoff() -> Backoff {
    Backoff { initial: Duration::from_millis(50), max: Duration::from_millis(200), stable_after: Duration::from_secs(60) }
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<HeldEvent>>,
    states: Mutex<Vec<StreamState>>,
}

impl EventSink for Recorder {
    fn event(&self, event: &HeldEvent) {
        self.events.lock().unwrap().push(event.clone());
    }
    fn state(&self, state: &StreamState) {
        self.states.lock().unwrap().push(state.clone());
    }
}

impl Recorder {
    fn messages(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.data.pointer("/envelope/dataMessage/message").and_then(Value::as_str).unwrap_or("?").to_owned())
            .collect()
    }
}

fn spawn_config() -> ConnectConfig {
    ConnectConfig::Spawn { binary_path: Some(fake().display().to_string()), account: None }
}

fn service(dir: &Path, recorder: Arc<Recorder>) -> Arc<Service> {
    Service::with_timeouts(
        Paths {
            app_data_dir: dir.to_path_buf(),
            data_dir: dir.to_path_buf(),
            log_file: Some(dir.join("signal-cli.log")),
            bundled: None,
        },
        recorder,
        Timeouts { backoff: fast_backoff(), grace: Duration::from_secs(2), ..Timeouts::default() },
        VaultBridge::disabled(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn process_matches_responses_and_forwards_notifications() {
    require_node!();
    let dir = temp_dir("process");
    let notes = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let sink = notes.clone();
    let process = RpcProcess::start(
        ProcessOptions {
            program: fake(),
            args: snowdrop_lib::config::spawn_args(&dir, None),
            log: Some(dir.join("err.log")),
            backoff: fast_backoff(),
            grace: Duration::from_secs(2),
        },
        Arc::new(move |m, p| sink.lock().unwrap().push((m, p))),
        Arc::new(|_| {}),
    );
    process.wait_running(Duration::from_secs(10)).await.unwrap();
    // Concurrent requests come back matched to the right callers.
    let (a, b, c) = tokio::join!(
        process.request("listAccounts", None, Duration::from_secs(10)),
        process.request("version", None, Duration::from_secs(10)),
        process.request("nope", None, Duration::from_secs(10)),
    );
    assert_eq!(a.unwrap()["result"][0]["number"], "+15550001");
    assert_eq!(b.unwrap()["result"]["version"], "0.0.0-fake");
    assert_eq!(c.unwrap()["error"]["code"], -32601);
    let mut params = serde_json::Map::new();
    params.insert("account".into(), json!("+15550001"));
    let sub = process.request("subscribeReceive", Some(&params), Duration::from_secs(10)).await.unwrap();
    assert_eq!(sub["result"], 0);
    eventually("two notifications", || notes.lock().unwrap().len() == 2).await;
    let (method, params) = notes.lock().unwrap()[0].clone();
    assert_eq!(method, "receive");
    assert_eq!(params["subscription"], 0);
    assert_eq!(params["result"]["account"], "+15550001");
    assert_eq!(process.pending_count(), 0);
    // stderr went to the log.
    eventually("stderr in the log", || std::fs::read_to_string(dir.join("err.log")).is_ok_and(|l| l.contains("fake signal-cli started"))).await;
    process.shutdown().await;
    assert_eq!(process.state(), ProcessState::Stopped);
    assert_eq!(process.request("version", None, Duration::from_secs(1)).await.unwrap_err().kind, ErrorKind::Unreachable);
}

#[tokio::test(flavor = "multi_thread")]
async fn process_restarts_after_a_crash() {
    require_node!();
    let dir = temp_dir("restart");
    std::fs::write(dir.join("fake.json"), r#"{"crashAfter":1}"#).unwrap();
    let states = Arc::new(Mutex::new(Vec::<ProcessState>::new()));
    let sink = states.clone();
    let process = RpcProcess::start(
        ProcessOptions {
            program: fake(),
            args: snowdrop_lib::config::spawn_args(&dir, None),
            log: None,
            backoff: fast_backoff(),
            grace: Duration::from_secs(2),
        },
        Arc::new(|_, _| {}),
        Arc::new(move |s| sink.lock().unwrap().push(s.clone())),
    );
    assert_eq!(process.wait_running(Duration::from_secs(10)).await.unwrap(), 1);
    process.request("version", None, Duration::from_secs(10)).await.unwrap();
    eventually("a restart", || states.lock().unwrap().iter().any(|s| matches!(s, ProcessState::Running { generation: 2 }))).await;
    assert!(states.lock().unwrap().iter().any(|s| matches!(s, ProcessState::Restarting { attempt: 1, .. })));
    process.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_program_is_reported_not_retried() {
    let dir = temp_dir("missing");
    let recorder = Arc::new(Recorder::default());
    let svc = service(&dir, recorder);
    let config = ConnectConfig::Spawn { binary_path: Some("/nonexistent/signal-cli".into()), account: None };
    let error = svc.connect(config).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotInstalled);
    assert!(error.message.contains("Install signal-cli"));
    // An invalid account never reaches the command line.
    let bad = ConnectConfig::Spawn { binary_path: Some(fake().display().to_string()), account: Some("--help".into()) };
    assert_eq!(svc.connect(bad).await.unwrap_err().kind, ErrorKind::Config);
}

#[tokio::test(flavor = "multi_thread")]
async fn service_delivers_events_with_resumable_cursors() {
    require_node!();
    let dir = temp_dir("service");
    let recorder = Arc::new(Recorder::default());
    let svc = service(&dir, recorder.clone());
    let info = svc.connect(spawn_config()).await.unwrap();
    assert_eq!(info.version.as_deref(), Some("0.0.0-fake"));
    let run = svc.subscribe(Some("+15550001".into()), String::new()).await.unwrap();
    eventually("two events", || recorder.events.lock().unwrap().len() == 2).await;
    assert_eq!(recorder.messages(), ["fake message 1", "fake message 2"]);
    let cursors: Vec<String> = recorder.events.lock().unwrap().iter().map(|e| e.cursor.clone()).collect();
    assert_eq!(cursors, [format!("{run}:1"), format!("{run}:2")]);
    assert!(recorder.states.lock().unwrap().contains(&StreamState::Open));

    // The UI stored the first; a reloaded webview resumes after it.
    svc.acknowledge(&cursors[0]);
    recorder.events.lock().unwrap().clear();
    svc.subscribe(Some("+15550001".into()), cursors[0].clone()).await.unwrap();
    assert_eq!(recorder.messages(), ["fake message 2"]);
    // A cursor from another run replays what's still held, never a guess.
    recorder.events.lock().unwrap().clear();
    svc.subscribe(Some("+15550001".into()), "oldrun:99".into()).await.unwrap();
    assert_eq!(recorder.messages(), ["fake message 2"]);
    svc.acknowledge(&cursors[1]);
    recorder.events.lock().unwrap().clear();
    svc.subscribe(Some("+15550001".into()), String::new()).await.unwrap();
    assert!(recorder.events.lock().unwrap().is_empty());

    // Requests go through; subscriptions stay Snowdrop's business.
    let reply = svc.request("listAccounts", None, Duration::from_secs(10)).await.unwrap();
    assert_eq!(reply["result"][0]["aci"], "11111111-1111-4111-8111-111111111111");
    assert_eq!(svc.request("subscribeReceive", None, Duration::from_secs(1)).await.unwrap_err().kind, ErrorKind::Config);
    // Reconnecting with the same settings keeps the running child.
    let pid = std::fs::read_to_string(dir.join("fake.pid")).unwrap();
    svc.connect(spawn_config()).await.unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("fake.pid")).unwrap(), pid);

    // Exit stops signal-cli.
    svc.shutdown().await;
    let proc = PathBuf::from(format!("/proc/{}", pid.trim()));
    eventually("signal-cli to exit", || !proc.exists()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn service_resubscribes_after_a_restart() {
    require_node!();
    let dir = temp_dir("resubscribe");
    // version, subscribeReceive, listAccounts → crash; the restart delivers again.
    std::fs::write(dir.join("fake.json"), r#"{"crashAfter":3,"messages":1}"#).unwrap();
    let recorder = Arc::new(Recorder::default());
    let svc = service(&dir, recorder.clone());
    svc.connect(spawn_config()).await.unwrap();
    svc.subscribe(None, String::new()).await.unwrap();
    eventually("the first event", || recorder.events.lock().unwrap().len() == 1).await;
    let _ = svc.request("listAccounts", None, Duration::from_secs(5)).await;
    eventually("an event from the restarted child", || recorder.events.lock().unwrap().len() >= 2).await;
    let states = recorder.states.lock().unwrap().clone();
    assert!(states.iter().any(|s| matches!(s, StreamState::Waiting { .. })), "{states:?}");
    assert_eq!(states.last(), Some(&StreamState::Open), "{states:?}");
    svc.shutdown().await;
}

/// A minimal signal-cli HTTP daemon: /api/v1/check, /api/v1/rpc and one SSE burst.
fn http_daemon() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let log = log.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut length = 0usize;
                let mut last_event_id = String::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    if lower.starts_with("last-event-id:") {
                        last_event_id = header.split_once(':').unwrap().1.trim().to_owned();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let path = request_line.split_whitespace().nth(1).unwrap_or("").to_owned();
                log.lock().unwrap().push(format!("{path} last-event-id={last_event_id}"));
                let reply = |stream: &mut std::net::TcpStream, ty: &str, body: &str| {
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {ty}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                };
                if path == "/api/v1/check" {
                    reply(&mut stream, "text/plain", "");
                } else if path == "/api/v1/rpc" {
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    let result = match request["method"].as_str() {
                        Some("listAccounts") => json!([{ "number": "+15550009", "aci": null }]),
                        _ => json!({ "ok": true }),
                    };
                    reply(&mut stream, "application/json", &json!({ "jsonrpc": "2.0", "result": result, "id": request["id"] }).to_string());
                } else if path.starts_with("/api/v1/events") {
                    let events = ":keep-alive\n\nid:7\nevent:receive\ndata:{\"envelope\":{\"dataMessage\":{\"message\":\"over http\"}}}\n\n";
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{events}");
                    std::thread::sleep(Duration::from_millis(300));
                }
            });
        }
    });
    (base, seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn external_daemon_mode_proxies_requests_and_events() {
    let (base, seen) = http_daemon();
    let dir = temp_dir("external");
    let recorder = Arc::new(Recorder::default());
    let svc = service(&dir, recorder.clone());
    let config = ConnectConfig::External { url: base.clone() };
    let probe = svc.probe(config.clone()).await.unwrap();
    assert_eq!(probe.accounts, Some(1));
    svc.connect(config).await.unwrap();
    let reply = svc.request("listGroups", None, Duration::from_secs(5)).await.unwrap();
    assert_eq!(reply["result"]["ok"], true);
    svc.subscribe(Some("+15550009".into()), "sse:5".into()).await.unwrap();
    eventually("an SSE event", || !recorder.events.lock().unwrap().is_empty()).await;
    let event = recorder.events.lock().unwrap()[0].clone();
    assert_eq!(event.cursor, "sse:7");
    assert_eq!(event.data["envelope"]["dataMessage"]["message"], "over http");
    let log = seen.lock().unwrap().clone();
    assert!(log.iter().any(|l| l == "/api/v1/events?account=%2B15550009 last-event-id=5"), "{log:?}");
    // Not a loopback address: refused before any connection.
    let remote = ConnectConfig::External { url: "http://192.0.2.1:8080".into() };
    assert_eq!(svc.connect(remote).await.unwrap_err().kind, ErrorKind::Config);
    svc.shutdown().await;
}

/// The sidecar `tauri-build` copies next to the app binary (target/<profile>/signal-cli).
fn real_signal_cli() -> Option<PathBuf> {
    let target = Path::new(env!("CARGO_TARGET_TMPDIR")).parent()?;
    ["debug", "release"].iter().map(|p| target.join(p).join("signal-cli")).find(|p| p.is_file())
}

/// Genuine signal-cli (the pinned native build, fetched by scripts/fetch-signal-cli.mjs)
/// over stdio, in multi-account mode with an empty data directory: no account needed.
#[tokio::test(flavor = "multi_thread")]
async fn real_signal_cli_speaks_json_rpc_over_stdio() {
    let Some(program) = real_signal_cli() else {
        eprintln!("skipped: no bundled signal-cli (run scripts/fetch-signal-cli.mjs and cargo build)");
        return;
    };
    let dir = temp_dir("real");
    let recorder = Arc::new(Recorder::default());
    let svc = Service::with_timeouts(
        Paths {
            app_data_dir: dir.clone(),
            data_dir: dir.join("data"),
            log_file: Some(dir.join("signal-cli.log")),
            bundled: Some(program),
        },
        recorder.clone(),
        Timeouts { backoff: fast_backoff(), grace: Duration::from_secs(5), ..Timeouts::default() },
        VaultBridge::disabled(),
    );
    let bundled = ConnectConfig::Spawn { binary_path: None, account: None };
    let probe = svc.probe(bundled.clone()).await.unwrap();
    assert!(probe.version.as_deref().is_some_and(|v| v.starts_with("0.")), "{probe:?}");
    let info = svc.connect(bundled).await.unwrap();
    assert_eq!(info.version, probe.version);
    let accounts = svc.request("listAccounts", None, Duration::from_secs(30)).await.unwrap();
    assert_eq!(accounts["result"], json!([]));
    let unknown = svc.request("noSuchMethod", None, Duration::from_secs(30)).await.unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    let groups = svc.request("listGroups", None, Duration::from_secs(30)).await.unwrap();
    assert_eq!(groups["error"]["code"], -32602, "{groups}");
    // Subscribing with no accounts still answers (subscription 0), and nothing arrives.
    svc.subscribe(None, String::new()).await.unwrap();
    assert!(recorder.states.lock().unwrap().contains(&StreamState::Open));
    assert!(recorder.events.lock().unwrap().is_empty());
    let started = Instant::now();
    svc.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(10));
}

/// One pre-populated vault plus the `(Vault, PathBuf, InstanceLock)` triple a
/// real `StorageService::vault_session_parts()` would hand over — built
/// straight from `Vault`/`InstanceLock`, so this test never needs a real
/// `StorageService` or keyring. Mirrors `vault_bridge`'s own unit test
/// fixture, kept here too since it exercises the vault through a real
/// `Service` and the fake signal-cli rather than in isolation.
fn vault_fixture(dir: &Path) -> snowdrop_lib::storage::VaultSessionParts {
    use snowdrop_lib::aead::Key32;
    use snowdrop_lib::vault::{InstanceLock, Vault, VAULT_ID_LEN};
    let vault = Vault::open(&dir.join("vault"), Key32::random(), [1u8; VAULT_ID_LEN]).unwrap();
    let lock = InstanceLock::acquire(&dir.join("app-data")).unwrap();
    (vault, dir.join("runtime"), lock)
}

/// End to end through a real `Service`: a managed child spawns against the
/// vault's runtime dir (not `paths.data_dir`), and `shutdown` stops it
/// *before* the vault's final sync and wipe — if it stopped the other way
/// round, the still-running fake signal-cli would still hold `fake.pid` open
/// in the runtime dir while the vault wiped it out from under it.
#[tokio::test(flavor = "multi_thread")]
async fn vault_backed_service_spawns_into_the_runtime_dir_and_stops_signal_cli_before_wiping_it() {
    require_node!();
    let dir = temp_dir("vault-backed");
    let parts = Mutex::new(Some(vault_fixture(&dir)));
    let (vault, vault_rx) = VaultBridge::new(false, Box::new(|| true), Box::new(move || parts.lock().unwrap().take()));
    tokio::spawn(snowdrop_lib::vault_bridge::run_sync_loop(vault.clone(), vault_rx));

    let recorder = Arc::new(Recorder::default());
    let svc = Service::with_timeouts(
        Paths {
            app_data_dir: dir.clone(),
            data_dir: dir.join("plaintext-should-not-be-used"),
            log_file: Some(dir.join("signal-cli.log")),
            bundled: None,
        },
        recorder,
        Timeouts { backoff: fast_backoff(), grace: Duration::from_secs(2), ..Timeouts::default() },
        vault,
    );
    svc.connect(spawn_config()).await.unwrap();
    // The managed child's pid file landed in the vault's runtime dir, never
    // in the plaintext fallback (docs/ENCRYPTION.md: "Snowdrop never lets
    // its folder exist on disk in plaintext").
    assert!(dir.join("runtime/fake.pid").exists());
    assert!(!dir.join("plaintext-should-not-be-used").exists());
    let pid = std::fs::read_to_string(dir.join("runtime/fake.pid")).unwrap();

    svc.shutdown().await;
    // Stopped, before the runtime dir was wiped out from under it: if the
    // vault had wiped first, this would either still find the process alive
    // or (worse) have raced a still-running signal-cli writing to a
    // directory that was disappearing underneath it.
    assert!(!PathBuf::from(format!("/proc/{}", pid.trim())).exists(), "signal-cli must have exited before shutdown returns");
    assert!(!dir.join("runtime").exists(), "the runtime dir must be wiped only after signal-cli stopped");
}
