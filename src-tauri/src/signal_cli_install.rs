//! Downloads signal-cli into the app data directory on first launch.
//!
//! Snowdrop itself never bundles the GPL-3.0 signal-cli binary (that keeps
//! the app around 10 MB and sidesteps distributing someone else's GPL binary
//! in our own package): instead the first time Settings → Connection or
//! onboarding needs signal-cli and none is configured or found, the UI can
//! ask for the pinned release to be downloaded here. `scripts/fetch-signal-
//! cli.mjs` (used only for the *optional* bundled build,
//! `npm run tauri:build:bundled`) and this module both read the exact same
//! pinned version/asset/checksum from `src-tauri/signal-cli.json`, so there
//! is exactly one place to bump them.
//!
//! The flow, driven by `commands::signal_cli_install*`:
//! 1. Stream the pinned release asset over HTTPS (reqwest + rustls; no
//!    OpenSSL anywhere in this app) into a `.part` file under the app data
//!    dir, reporting `Progress` as it goes.
//! 2. Verify its SHA-256 against the pinned value. A mismatch deletes the
//!    file and fails — nothing unverified is ever extracted.
//! 3. Extract the `.tar.gz` (flate2 + tar) into a scratch directory,
//!    rejecting any entry with an absolute path or a `..` component.
//! 4. Mark the `signal-cli` executable, build it in a fully-staged sibling
//!    directory, then `rename` that into place: the final
//!    `<app_data_dir>/bin/signal-cli/<version>/` either doesn't exist yet or
//!    is already complete, never half-written.
//!
//! The partial download can be cancelled (`CancelToken`) or resumed with an
//! HTTP `Range` request if the server supports it; a verification failure or
//! an extraction failure always leaves no partial *install* behind (the
//! `.part` download file may remain so a subsequent attempt can resume it).
//!
//! **Install location:** everything this module writes lives under
//! `<app_data_dir>/bin/` — a sibling of, not inside, `<app_data_dir>/signal-
//! cli/`, which is reserved for signal-cli's own *data* (see
//! `storage::legacy_signal_cli_dir`). Before the fix this module and
//! signal-cli's data dir shared the same `<app_data_dir>/signal-cli/`
//! folder, which made every installed binary look exactly like a legacy
//! plaintext signal-cli data directory: `storage::migrate_legacy` would sync
//! the ~370 MB binary into the vault, garbage-collect the *real* account
//! data's blobs (since they'd just been overwritten by the binary's
//! contents), and then delete the "legacy dir" — taking the binary with it.
//! [`migrate_old_installs`] moves any install left at the old location into
//! the new one, once, so an existing download survives this fix.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::is_executable;
use crate::error::{Error, ErrorKind};

/// The pinned-release data both this module and `scripts/fetch-signal-cli.mjs` read.
const PINNED_JSON: &str = include_str!("../signal-cli.json");

#[derive(Debug, Deserialize)]
struct PinnedFile {
    version: String,
    repo: String,
    assets: HashMap<String, AssetFile>,
    #[serde(rename = "downloadSizeBytes")]
    download_size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct AssetFile {
    name: String,
    sha256: String,
}

/// The release this build will download, for this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedAsset {
    pub version: String,
    pub repo: String,
    pub asset_name: String,
    pub sha256: String,
    pub download_size_bytes: Option<u64>,
}

impl PinnedAsset {
    /// `https://github.com/<owner>/<repo>/releases/download/v<version>/<asset>`.
    pub fn download_url(&self) -> String {
        format!("{}/releases/download/v{}/{}", self.repo, self.version, self.asset_name)
    }
}

fn host_triple() -> &'static str {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

fn pinned_file() -> Result<&'static PinnedFile, Error> {
    static PARSED: OnceLock<Result<PinnedFile, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| serde_json::from_str(PINNED_JSON).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| Error::new(ErrorKind::Internal, format!("signal-cli.json is malformed: {e}")))
}

/// The pinned release for this host, or an error naming the problem (no
/// pinned build for this platform — install signal-cli yourself instead).
pub fn pinned() -> Result<PinnedAsset, Error> {
    let file = pinned_file()?;
    let triple = host_triple();
    let asset = file.assets.get(triple).ok_or_else(|| {
        Error::new(
            ErrorKind::NotInstalled,
            format!(
                "Snowdrop doesn't have a signal-cli download for this platform ({triple}). \
                 Install signal-cli yourself and set its path in Settings → Connection."
            ),
        )
    })?;
    Ok(PinnedAsset {
        version: file.version.clone(),
        repo: file.repo.clone(),
        asset_name: asset.name.clone(),
        sha256: asset.sha256.clone(),
        download_size_bytes: file.download_size_bytes,
    })
}

/// `<app_data_dir>/bin/`: everything this module installs or stages, kept
/// apart from `<app_data_dir>/signal-cli/`, which is signal-cli's own *data*
/// dir (see the module docs and `storage::legacy_signal_cli_dir`).
fn bin_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bin")
}

/// `<app_data_dir>/bin/signal-cli/<version>/`.
pub fn install_dir(app_data_dir: &Path, version: &str) -> PathBuf {
    bin_dir(app_data_dir).join("signal-cli").join(version)
}

/// `<app_data_dir>/bin/signal-cli/<version>/signal-cli`.
pub fn binary_path(app_data_dir: &Path, version: &str) -> PathBuf {
    install_dir(app_data_dir, version).join("signal-cli")
}

/// Scratch space for in-progress downloads/extractions, kept apart from any
/// completed `<version>/` install directory so a crash never looks installed.
fn work_dir(app_data_dir: &Path) -> PathBuf {
    bin_dir(app_data_dir).join(".install-tmp")
}

/// One-time move of any install(s) left at the pre-fix location
/// (`<app_data_dir>/signal-cli/<version>/signal-cli`) into their new home
/// under `bin/` (see the module docs). Called once at startup, best-effort:
/// a version whose new location already exists is left exactly where it is
/// — nothing to gain by moving it, and the stray old copy is harmless, since
/// it's never treated as a signal-cli *data* dir (`storage::
/// legacy_signal_cli_dir` now requires a `data/` subdirectory) and so is
/// never synced into the vault.
///
/// This only ever reads `<app_data_dir>/signal-cli/` (the pre-fix location,
/// a *sibling* of `bin/`) — it never lists `<app_data_dir>/bin/` itself, so
/// `bin/signal-cli-history/` (the history-patched build an operator installs
/// with `scripts/build-signal-cli.sh --install`; see `config::patched_dir`)
/// is never seen by this function, let alone moved or deleted by it.
pub fn migrate_old_installs(app_data_dir: &Path) -> Result<(), Error> {
    let old_root = app_data_dir.join("signal-cli");
    let entries = match fs::read_dir(&old_root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(e)),
    };
    for entry in entries {
        let entry = entry.map_err(io_err)?;
        if entry.file_name() == ".install-tmp" {
            continue;
        }
        let old_dir = entry.path();
        if !old_dir.is_dir() {
            continue;
        }
        let Some(version) = old_dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        if !old_dir.join("signal-cli").is_file() {
            continue; // not a completed install (e.g. a version dir with no binary at all)
        }
        let new_dir = install_dir(app_data_dir, &version);
        if new_dir.exists() {
            continue; // the new location already has this version; leave the old copy alone
        }
        if let Some(parent) = new_dir.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        fs::rename(&old_dir, &new_dir).map_err(io_err)?;
        log::info!("signal-cli-install: moved an existing install of {version} from the old location to {}", new_dir.display());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<PathBuf>,
}

/// Whether the pinned version is already downloaded and installed.
pub fn status(app_data_dir: &Path) -> InstallStatus {
    match installed_binary(app_data_dir) {
        Some(path) => InstallStatus { installed: true, version: pinned().ok().map(|a| a.version), path: Some(path) },
        None => InstallStatus { installed: false, version: None, path: None },
    }
}

/// The downloaded signal-cli for the pinned version, if it's there and
/// executable (used by `config::resolve_binary`).
pub fn installed_binary(app_data_dir: &Path) -> Option<PathBuf> {
    let asset = pinned().ok()?;
    let path = binary_path(app_data_dir, &asset.version);
    is_executable(&path).then_some(path)
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

pub type ProgressSink = Arc<dyn Fn(Progress) + Send + Sync>;

/// A cooperative cancel flag shared between the running install and whatever
/// called `signal_cli_install_cancel`.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Per-app install state: the app data dir, and a handle to cancel whatever
/// install is currently running (if any).
pub struct InstallState {
    pub app_data_dir: PathBuf,
    cancel: Mutex<Option<CancelToken>>,
}

impl InstallState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir, cancel: Mutex::new(None) }
    }

    /// Registers a new in-progress install's cancel token; fails if one is
    /// already running.
    fn begin(&self) -> Result<CancelToken, Error> {
        let mut guard = self.cancel.lock().expect("install cancel lock");
        if guard.is_some() {
            return Err(Error::new(ErrorKind::Config, "signal-cli is already downloading."));
        }
        let token = CancelToken::new();
        *guard = Some(token.clone());
        Ok(token)
    }

    fn finish(&self) {
        self.cancel.lock().expect("install cancel lock").take();
    }

    /// Cancels the running install, if any; a no-op otherwise.
    pub fn cancel(&self) {
        if let Some(token) = self.cancel.lock().expect("install cancel lock").as_ref() {
            token.cancel();
        }
    }
}

fn http_client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| Error::new(ErrorKind::Internal, format!("couldn't build the HTTP client: {e}")))
}

fn io_err(e: std::io::Error) -> Error {
    Error::new(ErrorKind::Internal, e.to_string())
}

/// Downloads the pinned release and installs it, start to finish. Reports
/// progress and honours cancellation; see the module docs for the steps.
pub async fn install_pinned(
    state: &InstallState,
    on_progress: ProgressSink,
) -> Result<InstallStatus, Error> {
    let cancel = state.begin()?;
    let result = install_pinned_inner(&state.app_data_dir, on_progress, cancel).await;
    state.finish();
    result.map(|_| status(&state.app_data_dir))
}

async fn install_pinned_inner(
    app_data_dir: &Path,
    on_progress: ProgressSink,
    cancel: CancelToken,
) -> Result<PathBuf, Error> {
    let asset = pinned()?;
    let client = http_client()?;
    download_and_install(
        &client,
        &asset.download_url(),
        &asset.sha256,
        app_data_dir,
        &asset.version,
        on_progress,
        cancel,
    )
    .await
}

/// The generic worker behind `install_pinned`: everything except choosing
/// *which* release to fetch, so tests can point `url` at a local server
/// instead of github.com.
pub async fn download_and_install(
    client: &reqwest::Client,
    url: &str,
    sha256_expected: &str,
    app_data_dir: &Path,
    version: &str,
    on_progress: ProgressSink,
    cancel: CancelToken,
) -> Result<PathBuf, Error> {
    let work = work_dir(app_data_dir);
    fs::create_dir_all(&work).map_err(io_err)?;
    let part_path = work.join(format!("{version}.part"));

    download_to_file(client, url, &part_path, on_progress, cancel.clone()).await?;
    if cancel.is_cancelled() {
        return Err(Error::new(ErrorKind::Cancelled, "The signal-cli download was cancelled."));
    }

    let actual = sha256_file(&part_path)?;
    if !actual.eq_ignore_ascii_case(sha256_expected) {
        let _ = fs::remove_file(&part_path);
        return Err(Error::new(
            ErrorKind::Config,
            format!("The download didn't match what Snowdrop expected (checksum mismatch: expected {sha256_expected}, got {actual})."),
        ));
    }

    // The verified download is spent either way from here: extracted into
    // the install, or cleaned up if that fails. `CleanupGuard` removes it on
    // every exit from this point (including a `?` out of `extract_and_install`),
    // so a failed extraction never leaves the `.part` file behind.
    let _part_cleanup = CleanupGuard(&part_path);
    extract_and_install(&part_path, &work, app_data_dir, version)
}

/// Streams `url` into `part_path`, resuming from whatever's already there
/// with an HTTP `Range` request (falling back to a fresh download if the
/// server doesn't honour it). Checks `cancel` between chunks.
async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    on_progress: ProgressSink,
    cancel: CancelToken,
) -> Result<(), Error> {
    let mut existing = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);

    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let response = request.send().await.map_err(network_err)?;
    let status = response.status();
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(Error::new(ErrorKind::Unreachable, format!("signal-cli download failed: HTTP {status}")));
    }
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed {
        existing = 0;
    }
    let total = response.content_length().map(|len| len + existing);

    let mut file = if resumed {
        fs::OpenOptions::new().append(true).open(part_path).map_err(io_err)?
    } else {
        File::create(part_path).map_err(io_err)?
    };

    let mut received = existing;
    on_progress(Progress { received, total });
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let chunk = chunk.map_err(network_err)?;
        file.write_all(&chunk).map_err(io_err)?;
        received += chunk.len() as u64;
        on_progress(Progress { received, total });
    }
    Ok(())
}

fn network_err(e: reqwest::Error) -> Error {
    Error::new(ErrorKind::Unreachable, format!("Couldn't reach github.com: {e}"))
}

/// Removes `path` (file or directory, whichever it turns out to be, ignoring
/// either kind of "not found") when dropped. Used for install scratch space
/// (the `.part` download, the extraction and staging directories) so an
/// early return via `?` cleans up exactly like a normal success does,
/// without repeating the cleanup at every call site.
struct CleanupGuard<'a>(&'a Path);

impl Drop for CleanupGuard<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0);
        let _ = fs::remove_dir_all(self.0);
    }
}

fn sha256_file(path: &Path) -> Result<String, Error> {
    let mut file = File::open(path).map_err(io_err)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(io_err)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Extracts the verified tarball and installs it atomically at
/// `<app_data_dir>/signal-cli/<version>/signal-cli`: everything is built in
/// a staged sibling directory first, then a single `rename` puts it in
/// place, so the final directory is either absent or complete.
fn extract_and_install(archive_path: &Path, work: &Path, app_data_dir: &Path, version: &str) -> Result<PathBuf, Error> {
    let extract_tmp = work.join(format!("{version}.extract"));
    let _ = fs::remove_dir_all(&extract_tmp);
    fs::create_dir_all(&extract_tmp).map_err(io_err)?;
    // Cleaned up on any exit (success or a `?` below): nothing extracted is
    // needed once it's copied into `staged`, and a failed extraction leaves
    // nothing behind either.
    let _extract_cleanup = CleanupGuard(&extract_tmp);
    let extracted_binary = extract_tar_gz(archive_path, &extract_tmp)?;

    let staged = work.join(format!("{version}.staged"));
    let _ = fs::remove_dir_all(&staged);
    fs::create_dir_all(&staged).map_err(io_err)?;
    // Cleaned up the same way; once `rename` below succeeds this path no
    // longer exists, so the cleanup is a (harmless) no-op on success.
    let _staged_cleanup = CleanupGuard(&staged);
    let staged_binary = staged.join("signal-cli");
    fs::copy(&extracted_binary, &staged_binary).map_err(io_err)?;
    make_executable(&staged_binary)?;

    let final_dir = install_dir(app_data_dir, version);
    if let Some(parent) = final_dir.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
    }
    // Replace any stale leftover of the same version, then the atomic step.
    let _ = fs::remove_dir_all(&final_dir);
    fs::rename(&staged, &final_dir).map_err(io_err)?;

    Ok(final_dir.join("signal-cli"))
}

/// Extracts `archive_path` (a `.tar.gz`) into `dest`, refusing any entry
/// whose path is absolute or contains a `..` component, and any entry that
/// isn't a plain regular file or a directory (symlinks, hard links, devices,
/// FIFOs, …), and returns the path of the `signal-cli` executable it found.
///
/// Two independent guards keep an entry from writing outside `dest`: the
/// explicit path check below, and `Entry::unpack_in`, which tar itself
/// refuses to let escape `dest` (unlike the unchecked `Entry::unpack`).
fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<PathBuf, Error> {
    let file = File::open(archive_path).map_err(io_err)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut found: Option<PathBuf> = None;
    let entries = archive.entries().map_err(io_err)?;
    for entry in entries {
        let mut entry = entry.map_err(io_err)?;
        let raw_path = entry.path().map_err(io_err)?.into_owned();
        if raw_path.is_absolute() || raw_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(Error::new(
                ErrorKind::Config,
                format!("The signal-cli archive contains an unsafe path ({}) and was rejected.", raw_path.display()),
            ));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(Error::new(
                ErrorKind::Config,
                format!(
                    "The signal-cli archive contains an entry that isn't a file or directory ({}, {:?}) and was rejected.",
                    raw_path.display(),
                    entry_type
                ),
            ));
        }
        let out_path = dest.join(&raw_path);
        if entry_type.is_dir() {
            fs::create_dir_all(&out_path).map_err(io_err)?;
            continue;
        }
        let unpacked = entry.unpack_in(dest).map_err(io_err)?;
        if !unpacked {
            return Err(Error::new(
                ErrorKind::Config,
                format!("The signal-cli archive contains an unsafe path ({}) and was rejected.", raw_path.display()),
            ));
        }
        if found.is_none() && out_path.file_name().and_then(|n| n.to_str()) == Some("signal-cli") {
            found = Some(out_path);
        }
    }
    found.ok_or_else(|| Error::new(ErrorKind::Config, "The signal-cli archive didn't contain a signal-cli executable.".to_owned()))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = fs::metadata(path).map_err(io_err)?.permissions();
    perm.set_mode(0o755);
    fs::set_permissions(path, perm).map_err(io_err)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdTcpListener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-install-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    fn noop_progress() -> ProgressSink {
        Arc::new(|_| {})
    }

    /// A minimal in-memory `.tar.gz` with a single executable `signal-cli`
    /// file, whose content is `content` (so tests can tell builds apart).
    fn make_archive(content: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path("signal-cli-0.0.0/bin/signal-cli").unwrap();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, content).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A tar.gz with one entry that tries to escape the extraction directory.
    /// `Header::set_path` itself refuses a `..` component (so a well-behaved
    /// writer can't produce this), but nothing stops a hand-crafted archive
    /// from putting one in the raw name field, so the raw bytes are written
    /// directly here to simulate that.
    fn make_traversal_archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let name = b"../../etc/evil";
        header.as_mut_bytes()[..name.len()].copy_from_slice(name);
        header.set_size(4);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, &b"evil"[..]).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// Same idea, but an absolute path instead of a `..` component.
    fn make_absolute_path_archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let name = b"/etc/evil";
        header.as_mut_bytes()[..name.len()].copy_from_slice(name);
        header.set_size(4);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, &b"evil"[..]).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A tar.gz with one symlink entry pointing outside the extraction
    /// directory (`evil-link` -> `/etc`).
    fn make_symlink_archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        builder.append_link(&mut header, "evil-link", "/etc").unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A tar.gz with one hard-link entry pointing at a file outside the
    /// extraction directory.
    fn make_hard_link_archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Link);
        header.set_size(0);
        builder.append_link(&mut header, "evil-hardlink", "/etc/passwd").unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A tar.gz that first symlinks a directory outside the extraction
    /// directory, then drops a file through it (the classic "symlinked
    /// directory" escape: if the symlink were followed, the file would land
    /// outside `dest`).
    fn make_symlinked_dir_archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut link_header = tar::Header::new_gnu();
        link_header.set_entry_type(tar::EntryType::Symlink);
        link_header.set_size(0);
        builder.append_link(&mut link_header, "evil-dir", "/tmp").unwrap();
        let mut file_header = tar::Header::new_gnu();
        file_header.set_path("evil-dir/pwned").unwrap();
        file_header.set_size(4);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        builder.append(&file_header, &b"evil"[..]).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn sha256_bytes(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// A tiny HTTP/1.1 server for exactly one purpose: serving a fixed byte
    /// body for every GET, honouring a `Range: bytes=N-` request with a 206
    /// response when `support_range` is set. No real network is ever used in
    /// these tests.
    struct TestServer {
        addr: std::net::SocketAddr,
        _task: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        async fn start(body: Vec<u8>, support_range: bool) -> Self {
            // Bind synchronously so the address is known before any request races it.
            let std_listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
            std_listener.set_nonblocking(true).unwrap();
            let addr = std_listener.local_addr().unwrap();
            let listener = TcpListener::from_std(std_listener).unwrap();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else { return };
                    let body = body.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 8192];
                        let n = match socket.read(&mut buf).await {
                            Ok(n) => n,
                            Err(_) => return,
                        };
                        let request = String::from_utf8_lossy(&buf[..n]);
                        let range = support_range
                            .then(|| {
                                request.lines().find_map(|l| {
                                    let l = l.to_ascii_lowercase();
                                    l.strip_prefix("range: bytes=").and_then(|v| v.trim_end_matches('-').trim().parse::<u64>().ok())
                                })
                            })
                            .flatten();
                        let response = match range {
                            Some(start) if (start as usize) < body.len() => {
                                let slice = &body[start as usize..];
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                                    slice.len(), start, body.len() - 1, body.len()
                                )
                            }
                            _ => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()),
                        };
                        let _ = socket.write_all(response.as_bytes()).await;
                        let send_body: &[u8] = match range {
                            Some(start) if (start as usize) < body.len() => &body[start as usize..],
                            _ => &body,
                        };
                        let _ = socket.write_all(send_body).await;
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self { addr, _task: task }
        }

        fn url(&self) -> String {
            format!("http://{}/signal-cli.tar.gz", self.addr)
        }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().use_rustls_tls().build().unwrap()
    }

    #[tokio::test]
    async fn downloads_verifies_and_installs() {
        let archive = make_archive(b"fake signal-cli binary");
        let sha = sha256_bytes(&archive);
        let server = TestServer::start(archive, false).await;
        let app_data = temp_dir("good");
        let app_data = app_data.path();

        let binary = download_and_install(
            &client(),
            &server.url(),
            &sha,
            app_data,
            "9.9.9",
            noop_progress(),
            CancelToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(binary, install_dir(app_data, "9.9.9").join("signal-cli"));
        assert!(is_executable(&binary));
        assert_eq!(fs::read(&binary).unwrap(), b"fake signal-cli binary");
        // No leftover partial-download file.
        assert!(!work_dir(app_data).join("9.9.9.part").exists());
    }

    #[tokio::test]
    async fn rejects_a_checksum_mismatch_and_leaves_no_partial_download() {
        let archive = make_archive(b"fake signal-cli binary");
        let server = TestServer::start(archive, false).await;
        let app_data = temp_dir("bad-checksum");
        let app_data = app_data.path();

        let err = download_and_install(
            &client(),
            &server.url(),
            "0000000000000000000000000000000000000000000000000000000000000000",
            app_data,
            "9.9.9",
            noop_progress(),
            CancelToken::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("checksum mismatch"), "{}", err.message);
        assert!(!work_dir(app_data).join("9.9.9.part").exists());
        assert!(!install_dir(app_data, "9.9.9").exists());
    }

    #[test]
    fn rejects_tar_entries_that_escape_the_extraction_directory() {
        let app_data = temp_dir("traversal");
        let app_data = app_data.path();
        let archive_path = app_data.join("evil.tar.gz");
        fs::write(&archive_path, make_traversal_archive()).unwrap();
        let dest = app_data.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let err = extract_tar_gz(&archive_path, &dest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("unsafe path"), "{}", err.message);
        // Nothing escaped: the parent of `dest` has no new "etc" directory.
        assert!(!app_data.join("etc").exists());
    }

    #[test]
    fn rejects_tar_entries_with_an_absolute_path() {
        let app_data = temp_dir("absolute");
        let app_data = app_data.path();
        let archive_path = app_data.join("evil.tar.gz");
        fs::write(&archive_path, make_absolute_path_archive()).unwrap();
        let dest = app_data.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let err = extract_tar_gz(&archive_path, &dest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("unsafe path"), "{}", err.message);
        assert!(!Path::new("/etc/evil").exists());
    }

    #[test]
    fn rejects_tar_entries_that_are_symlinks() {
        let app_data = temp_dir("symlink");
        let app_data = app_data.path();
        let archive_path = app_data.join("evil.tar.gz");
        fs::write(&archive_path, make_symlink_archive()).unwrap();
        let dest = app_data.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let err = extract_tar_gz(&archive_path, &dest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("isn't a file or directory"), "{}", err.message);
        // Nothing was written at all, not even inside dest.
        assert!(fs::read_dir(&dest).unwrap().next().is_none());
    }

    #[test]
    fn rejects_tar_entries_that_are_hard_links() {
        let app_data = temp_dir("hardlink");
        let app_data = app_data.path();
        let archive_path = app_data.join("evil.tar.gz");
        fs::write(&archive_path, make_hard_link_archive()).unwrap();
        let dest = app_data.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let err = extract_tar_gz(&archive_path, &dest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("isn't a file or directory"), "{}", err.message);
        assert!(fs::read_dir(&dest).unwrap().next().is_none());
    }

    #[test]
    fn rejects_a_symlinked_directory_followed_by_a_file_under_it() {
        let app_data = temp_dir("symlinked-dir");
        let app_data = app_data.path();
        let archive_path = app_data.join("evil.tar.gz");
        fs::write(&archive_path, make_symlinked_dir_archive()).unwrap();
        let dest = app_data.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let err = extract_tar_gz(&archive_path, &dest).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(err.message.contains("isn't a file or directory"), "{}", err.message);
        // The symlink entry was rejected before the file entry under it was
        // ever reached, so nothing escaped into /tmp and dest stays empty.
        assert!(fs::read_dir(&dest).unwrap().next().is_none());
        assert!(!Path::new("/tmp/pwned").exists());
    }

    #[test]
    fn a_failed_extraction_leaves_no_install_directory() {
        let app_data = temp_dir("extract-fail");
        let app_data = app_data.path();
        // An archive with no signal-cli executable inside it at all.
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path("README").unwrap();
        header.set_size(3);
        header.set_cksum();
        builder.append(&header, &b"hi\n"[..]).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        let archive = encoder.finish().unwrap();
        let archive_path = app_data.join("broken.tar.gz");
        fs::write(&archive_path, &archive).unwrap();
        let work = work_dir(app_data);
        fs::create_dir_all(&work).unwrap();

        let err = extract_and_install(&archive_path, &work, app_data, "9.9.9").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(!install_dir(app_data, "9.9.9").exists());
        // No leftover scratch directories either.
        assert!(!work.join("9.9.9.extract").exists());
        assert!(!work.join("9.9.9.staged").exists());
    }

    #[tokio::test]
    async fn failed_extraction_leaves_no_leftover_part_file_or_scratch_directories() {
        // Downloads and checksum-verifies fine, but has nothing to extract.
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path("README").unwrap();
        header.set_size(3);
        header.set_cksum();
        builder.append(&header, &b"hi\n"[..]).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        let archive = encoder.finish().unwrap();
        let sha = sha256_bytes(&archive);
        let server = TestServer::start(archive, false).await;
        let app_data = temp_dir("download-extract-fail");
        let app_data = app_data.path();

        let err = download_and_install(
            &client(),
            &server.url(),
            &sha,
            app_data,
            "9.9.9",
            noop_progress(),
            CancelToken::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(err.kind, ErrorKind::Config);
        let work = work_dir(app_data);
        assert!(!work.join("9.9.9.part").exists());
        assert!(!work.join("9.9.9.extract").exists());
        assert!(!work.join("9.9.9.staged").exists());
        assert!(!install_dir(app_data, "9.9.9").exists());
    }

    #[tokio::test]
    async fn atomic_install_replaces_a_stale_same_version_directory_in_one_step() {
        let archive = make_archive(b"second build");
        let sha = sha256_bytes(&archive);
        let server = TestServer::start(archive, false).await;
        let app_data = temp_dir("atomic");
        let app_data = app_data.path();

        // A stale, half-written install already "exists" at this version.
        let stale_dir = install_dir(app_data, "9.9.9");
        fs::create_dir_all(&stale_dir).unwrap();
        fs::write(stale_dir.join("signal-cli"), b"old, broken").unwrap();

        let binary = download_and_install(
            &client(),
            &server.url(),
            &sha,
            app_data,
            "9.9.9",
            noop_progress(),
            CancelToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(fs::read(&binary).unwrap(), b"second build");
    }

    #[tokio::test]
    async fn resumes_a_partial_download_with_a_range_request() {
        let archive = make_archive(b"a reasonably long fake signal-cli binary payload");
        let sha = sha256_bytes(&archive);
        let server = TestServer::start(archive.clone(), true).await;
        let app_data = temp_dir("resume");
        let app_data = app_data.path();

        // Simulate a previous attempt that only got partway through.
        let work = work_dir(app_data);
        fs::create_dir_all(&work).unwrap();
        let half = archive.len() / 2;
        fs::write(work.join("9.9.9.part"), &archive[..half]).unwrap();

        let binary =
            download_and_install(&client(), &server.url(), &sha, app_data, "9.9.9", noop_progress(), CancelToken::new())
                .await
                .unwrap();

        assert_eq!(fs::read(&binary).unwrap(), b"a reasonably long fake signal-cli binary payload");
    }

    #[tokio::test]
    async fn cancelling_stops_the_download_without_installing() {
        let archive = make_archive(&vec![b'x'; 2_000_000]);
        let sha = sha256_bytes(&archive);
        let server = TestServer::start(archive, false).await;
        let app_data = temp_dir("cancel");
        let app_data = app_data.path();

        let cancel = CancelToken::new();
        cancel.cancel(); // already cancelled: the very first check should stop it

        let err = download_and_install(&client(), &server.url(), &sha, app_data, "9.9.9", noop_progress(), cancel)
            .await
            .unwrap_err();

        assert_eq!(err.kind, ErrorKind::Cancelled);
        assert!(!install_dir(app_data, "9.9.9").exists());
    }

    #[test]
    fn status_reports_not_installed_until_the_binary_is_in_place() {
        let app_data = temp_dir("status");
        let app_data = app_data.path();
        let before = status(app_data);
        assert!(!before.installed);
        if let Ok(asset) = pinned() {
            let path = binary_path(app_data, &asset.version);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"fake").unwrap();
            make_executable(&path).unwrap();
            let after = status(app_data);
            assert!(after.installed);
            assert_eq!(after.version.as_deref(), Some(asset.version.as_str()));
            assert_eq!(after.path, Some(path));
        }
    }

    #[test]
    fn migrate_old_installs_moves_an_install_from_the_pre_fix_location() {
        let app_data = temp_dir("migrate-old");
        let app_data = app_data.path();
        let old_dir = app_data.join("signal-cli").join("9.9.9");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("signal-cli"), b"old binary bytes").unwrap();
        make_executable(&old_dir.join("signal-cli")).unwrap();

        migrate_old_installs(app_data).unwrap();

        let new_path = binary_path(app_data, "9.9.9");
        assert!(new_path.is_file(), "the binary must now be at the new bin/ location");
        assert_eq!(fs::read(&new_path).unwrap(), b"old binary bytes");
        assert!(is_executable(&new_path), "the moved binary must stay executable");
        assert!(!old_dir.exists(), "the old version dir must be gone, moved rather than copied");
    }

    #[test]
    fn migrate_old_installs_leaves_an_already_migrated_version_alone() {
        let app_data = temp_dir("migrate-skip");
        let app_data = app_data.path();
        let old_dir = app_data.join("signal-cli").join("9.9.9");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("signal-cli"), b"stale copy").unwrap();

        let new_dir = install_dir(app_data, "9.9.9");
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join("signal-cli"), b"current install").unwrap();

        migrate_old_installs(app_data).unwrap();

        assert_eq!(fs::read(new_dir.join("signal-cli")).unwrap(), b"current install", "the new location must be untouched");
        assert!(old_dir.join("signal-cli").exists(), "the stale old copy is left alone, not deleted, when the new location already exists");
    }

    #[test]
    fn migrate_old_installs_is_a_no_op_with_nothing_to_migrate() {
        let app_data = temp_dir("migrate-nothing");
        let app_data = app_data.path();
        migrate_old_installs(app_data).unwrap(); // no `signal-cli/` dir at all
        fs::create_dir_all(app_data.join("signal-cli").join(".install-tmp")).unwrap();
        migrate_old_installs(app_data).unwrap(); // only scratch space, no version dirs
    }
}
