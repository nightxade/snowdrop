//! End-to-end vault test against the *real* signal-cli (not the Node fake
//! `tests/signal_cli.rs` otherwise uses): builds the same pieces `lib.rs`
//! wires up in `setup()` — `StorageService` (behind an in-memory
//! `FakeStore` keyring; the real OS keyring is never touched), a
//! `VaultBridge` and a `Service` — and drives a real signal-cli child
//! through them, over the real `$XDG_RUNTIME_DIR`.
//!
//! Ignored by default (it needs a real signal-cli binary and a real
//! tmpfs-backed `$XDG_RUNTIME_DIR`, neither of which the normal test suite
//! can assume). Run it with:
//!
//! ```text
//! SNOWDROP_E2E_SIGNAL_CLI=/path/to/signal-cli cargo test --test vault_e2e -- --ignored --nocapture
//! ```
//!
//! The binary at that path is the same pinned native build
//! `src-tauri/signal-cli.json` describes (fetch it with the URL/sha256
//! there, verify, and extract — see the task notes for the exact steps);
//! it's the identical file the app itself downloads on first run.

use serde_json::json;
use snowdrop_lib::config::ConnectConfig;
use snowdrop_lib::error::Error;
use snowdrop_lib::events::HeldEvent;
use snowdrop_lib::process::Backoff;
use snowdrop_lib::secrets::FakeStore;
use snowdrop_lib::service::{EventSink, Paths, Service, StreamState, Timeouts};
use snowdrop_lib::storage::{self, StorageService, StoragePaths};
use snowdrop_lib::vault_bridge::{self, VaultBridge};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

fn fast_backoff() -> Backoff {
    Backoff { initial: Duration::from_millis(50), max: Duration::from_millis(200), stable_after: Duration::from_secs(60) }
}

async fn eventually(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A resolver that always hands back the same pre-made directory (mirrors
/// `storage::tests::fake_runtime_resolver`, which is private to that
/// module) — here, a unique subdirectory of the real `$XDG_RUNTIME_DIR`
/// rather than an ordinary temp dir, so the vault really is backed by RAM.
fn fixed_runtime_resolver(dir: PathBuf) -> storage::RuntimeDirResolver {
    Box::new(move || {
        std::fs::create_dir_all(&dir).map_err(|e| Error::new(snowdrop_lib::error::ErrorKind::Internal, e.to_string()))?;
        Ok(dir.clone())
    })
}

/// The shared, in-memory-keyring `StorageService` a [`build_session`] hands
/// back, guarded the same way `lib.rs`'s own `app.manage(Mutex<...>)` guards
/// the real one.
type SharedStorage = Arc<Mutex<StorageService<Arc<FakeStore>>>>;

/// Builds the `(StorageService behind Arc<Mutex>, VaultBridge, Service)`
/// triple exactly the way `lib.rs`'s `setup()` does, for one "process" —
/// `store` is shared across two calls to simulate two launches of the same
/// app seeing the same OS keyring.
fn build_session(
    app_data_dir: &Path,
    log_file: &Path,
    runtime_dir: PathBuf,
    store: Arc<FakeStore>,
    recorder: Arc<Recorder>,
) -> (SharedStorage, Arc<VaultBridge>, Arc<Service>) {
    let storage_paths = StoragePaths::new(app_data_dir.to_path_buf(), Some(log_file.to_path_buf()), false);
    let mut storage_service = StorageService::new(storage_paths, store, fixed_runtime_resolver(runtime_dir));
    storage_service.setup().expect("storage setup");
    let storage = Arc::new(Mutex::new(storage_service));

    let storage_for_unlock = storage.clone();
    let is_unlocked: vault_bridge::IsUnlocked =
        Box::new(move || storage_for_unlock.lock().expect("storage lock").webcache_key().is_some());
    let storage_for_parts = storage.clone();
    let take_session_parts: vault_bridge::TakeSessionParts =
        Box::new(move || storage_for_parts.lock().expect("storage lock").vault_session_parts());
    let (vault, vault_rx) = VaultBridge::new(false, is_unlocked, take_session_parts);
    tokio::spawn(vault_bridge::run_sync_loop(vault.clone(), vault_rx));

    let service = Service::with_timeouts(
        Paths {
            app_data_dir: app_data_dir.to_path_buf(),
            // Never used while the vault applies — the managed child always
            // spawns into the vault's own runtime dir instead
            // (docs/ENCRYPTION.md: "Snowdrop never lets its folder exist on
            // disk in plaintext").
            data_dir: app_data_dir.join("plaintext-should-not-be-used"),
            log_file: Some(log_file.to_path_buf()),
            bundled: None,
        },
        recorder,
        Timeouts { start: Duration::from_secs(30), first_answer: Duration::from_secs(30), backoff: fast_backoff(), grace: Duration::from_secs(5) },
        vault.clone(),
    );
    (storage, vault, service)
}

/// Every process on Linux whose `cmdline` contains `needle`, joined with
/// spaces — used to confirm signal-cli's actual argv, not just the path
/// Snowdrop *intended* to pass it.
fn find_cmdline_containing(needle: &str) -> Option<String> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let pid_str = entry.file_name().to_string_lossy().into_owned();
        if !pid_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path().join("cmdline")) else { continue };
        let joined = bytes.split(|&b| b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect::<Vec<_>>().join(" ");
        if joined.contains(needle) {
            return Some(joined);
        }
    }
    None
}

/// Recursively collects every file under `dir`, skipping any whose file
/// name is in `except`.
fn collect_files(dir: &Path, except: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            collect_files(&path, except, out);
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if except.contains(&name) {
            continue;
        }
        out.push(path);
    }
}

/// signal-cli's own plaintext JSON (`{"accounts": [...], "version": N}`,
/// `account.db`'s header, ...) must never appear unsealed anywhere under the
/// app data dir, apart from Snowdrop's own non-secret files.
fn assert_no_plaintext(app_data_dir: &Path) {
    let markers: [&[u8]; 3] = [b"\"accounts\"", b"\"version\"", b"SQLite format 3"];
    let mut files = Vec::new();
    collect_files(app_data_dir, &["keys.json", "signal-cli.log"], &mut files);
    assert!(!files.is_empty(), "expected at least the vault's manifest/blobs under {}", app_data_dir.display());
    for path in files {
        let bytes = std::fs::read(&path).unwrap_or_default();
        for marker in markers {
            assert!(
                !bytes.windows(marker.len()).any(|w| w == marker),
                "{} contains the plaintext marker {:?} — signal-cli data leaked unsealed",
                path.display(),
                String::from_utf8_lossy(marker)
            );
        }
    }
}

/// Builds and drives a real signal-cli through the vault, end to end.
///
/// Needs `SNOWDROP_E2E_SIGNAL_CLI` set to a real signal-cli binary (see the
/// module docs) and a real, tmpfs-backed `$XDG_RUNTIME_DIR`; skipped
/// otherwise, even under `--ignored`, so a stray run never fails for
/// reasons unrelated to the vault itself.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_signal_cli_round_trips_through_the_vault() {
    let Ok(signal_cli) = std::env::var("SNOWDROP_E2E_SIGNAL_CLI") else {
        eprintln!("skipped: set SNOWDROP_E2E_SIGNAL_CLI=/path/to/signal-cli to run this test");
        return;
    };
    let signal_cli = PathBuf::from(signal_cli).canonicalize().expect("SNOWDROP_E2E_SIGNAL_CLI must point at a real file");
    let Ok(xdg_runtime_dir) = std::env::var("XDG_RUNTIME_DIR") else {
        eprintln!("skipped: XDG_RUNTIME_DIR isn't set");
        return;
    };
    let xdg_runtime_dir = PathBuf::from(xdg_runtime_dir);

    // The app's own data: a disposable temp dir (removed on drop), never
    // the real XDG app-data location.
    let app_data = tempfile::Builder::new().prefix("snowdrop-e2e-appdata-").tempdir().expect("temp app data dir");
    let app_data_dir = app_data.path().to_path_buf();
    let log_file = app_data_dir.join("signal-cli.log");
    let store = Arc::new(FakeStore::new());

    // ---- First session: set up storage, connect, do some offline work ----
    let runtime1 = tempfile::Builder::new()
        .prefix("snowdrop-e2e-runtime1-")
        .tempdir_in(&xdg_runtime_dir)
        .expect("a unique subdir of the real XDG_RUNTIME_DIR");
    let recorder = Arc::new(Recorder::default());
    let (storage, vault, service) =
        build_session(&app_data_dir, &log_file, runtime1.path().to_path_buf(), store.clone(), recorder.clone());

    {
        let status = storage.lock().unwrap().setup_new(storage::SetupMode::Keyring, None).expect("first-time setup");
        assert_eq!(status.state, "unlocked");
    }

    let config = ConnectConfig::Spawn { binary_path: Some(signal_cli.display().to_string()), account: None };
    let info = service.connect(config).await.expect("connect to the real signal-cli");
    assert_eq!(info.mode, "spawn");
    assert!(info.version.as_deref().is_some_and(|v| v.starts_with("0.")), "{info:?}");

    // signal-cli was spawned with `--config` inside the RAM runtime dir —
    // confirmed two ways: the path Snowdrop told it to use really is under
    // the real XDG_RUNTIME_DIR, and the actual child process's argv agrees.
    assert!(runtime1.path().starts_with(&xdg_runtime_dir), "{}", runtime1.path().display());
    let needle = runtime1.path().to_str().unwrap();
    eventually("signal-cli's cmdline to show up in /proc", Duration::from_secs(5), || find_cmdline_containing(needle).is_some())
        .await;
    let cmdline = find_cmdline_containing(needle).unwrap();
    assert!(cmdline.contains("--config"), "{cmdline}");
    assert!(cmdline.contains(needle), "{cmdline}");

    // A few offline requests — no account and no network needed.
    let accounts = service.request("listAccounts", None, Duration::from_secs(10)).await.unwrap();
    assert_eq!(accounts["result"], json!([]));
    let unknown = service.request("noSuchMethod", None, Duration::from_secs(10)).await.unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    // Subscribing with no accounts just opens the stream; nothing to receive.
    service.subscribe(None, String::new()).await.unwrap();

    // Just starting the daemon and listing accounts is enough activity for
    // signal-cli to write its own `data/accounts.json` into the runtime
    // dir — verified directly, so the rest of this test (sync, no-
    // plaintext, restore) is exercising something real.
    eventually("signal-cli to write data/accounts.json", Duration::from_secs(5), || {
        runtime1.path().join("data/accounts.json").is_file()
    })
    .await;

    // Trigger a sync and wait for the vault to actually pick it up.
    let vault_dir = app_data_dir.join("vault");
    vault.trigger();
    eventually("a manifest to land in the vault", Duration::from_secs(10), || vault_dir.join("manifest").is_file()).await;
    assert!(std::fs::read_dir(vault_dir.join("blobs")).unwrap().next().is_some(), "the vault should have at least one blob by now");

    // Shutdown: signal-cli stops, then the vault's final sync and wipe.
    service.shutdown().await;
    assert!(!runtime1.path().exists(), "the runtime dir must be wiped after shutdown");
    assert!(vault_dir.join("manifest").is_file());
    assert!(std::fs::read_dir(vault_dir.join("blobs")).unwrap().next().is_some());
    assert!(!app_data_dir.join("plaintext-should-not-be-used").exists(), "the fallback plaintext dir must never be used");

    assert_no_plaintext(&app_data_dir);

    // ---- Second session: a fresh "process" restores into a fresh runtime dir ----
    let runtime2 = tempfile::Builder::new()
        .prefix("snowdrop-e2e-runtime2-")
        .tempdir_in(&xdg_runtime_dir)
        .expect("a second, distinct unique subdir of the real XDG_RUNTIME_DIR");
    let recorder2 = Arc::new(Recorder::default());
    let (storage2, _vault2, service2) =
        build_session(&app_data_dir, &log_file, runtime2.path().to_path_buf(), store, recorder2);

    // The same keyring secret (shared `FakeStore`) auto-unlocks a fresh
    // process, same as a real relaunch (docs/ENCRYPTION.md).
    assert_eq!(storage2.lock().unwrap().status().state, "unlocked");

    let config2 = ConnectConfig::Spawn { binary_path: Some(signal_cli.display().to_string()), account: None };
    service2.connect(config2).await.expect("connect a second time, restoring into a fresh runtime dir");
    // The vault's restore ran *before* signal-cli started (inside
    // `connect`), so the file signal-cli wrote in the first session is
    // already there — this is the actual content round-tripping through
    // the vault, not just signal-cli writing it fresh a second time.
    let restored_accounts = std::fs::read_to_string(runtime2.path().join("data/accounts.json"))
        .expect("the restored data/accounts.json must be there before signal-cli even starts");
    assert!(restored_accounts.contains("\"accounts\""), "{restored_accounts}");

    let accounts2 = service2.request("listAccounts", None, Duration::from_secs(10)).await.unwrap();
    assert_eq!(accounts2["result"], json!([]));

    service2.shutdown().await;
    assert!(!runtime2.path().exists());

    // Best-effort cleanup beyond what `TempDir`/the vault already removed.
    let _ = std::fs::remove_dir_all(runtime1.path());
    let _ = std::fs::remove_dir_all(runtime2.path());
}
