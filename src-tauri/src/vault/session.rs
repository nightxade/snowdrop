//! Orchestrates restore, sync and crash recovery around the signal-cli
//! runtime dir (docs/ENCRYPTION.md, "signal-cli vault", "Attachment
//! budget", "Crash recovery"). Still no Tauri commands or service wiring
//! here — that's task 4 — but this is where the three pieces (`Vault`, the
//! RAM-backed runtime dir, the instance lock) meet: `VaultSession::start`
//! decides whether it's looking at a clean slate or a crashed previous
//! session, `ensure_media`/`evict_media` implement the on-demand media
//! budget, and `shutdown` leaves things safe to start again either way.
//!
//! Because media is restored lazily, a media relpath missing from the
//! runtime dir doesn't mean signal-cli deleted it — it may just never have
//! been hydrated, or have been evicted back out by
//! [`evict_media`](VaultSession::evict_media). `VaultSession` tracks which
//! media relpaths it knows are actually materialized (`materialized_media`)
//! and only lets its own `sync` drop one that's missing *and* was
//! materialized; a non-media relpath missing from the runtime dir is still
//! always a real deletion.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, ErrorKind};

use super::lock::InstanceLock;
use super::manifest::{self, ManifestEntry};
use super::sync::{self, WalkEntry};
use super::{from_hex, io_err, restore, to_hex, validate_relpath, write_secure_file, Vault, MARKER_FILE_NAME, VAULT_ID_LEN};

/// Manifest relpath prefixes [`VaultSession::start`] never restores up
/// front: the bulk of a vault's bytes, hydrated instead by
/// [`VaultSession::ensure_media`] on demand (docs/ENCRYPTION.md,
/// "Attachment budget").
pub const MEDIA_PREFIXES: &[&str] = &["attachments/", "avatars/", "stickers/"];

/// Default runtime media budget (docs/ENCRYPTION.md, "Attachment budget").
pub const DEFAULT_MEDIA_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
/// Default idle time before an already-synced media file is eligible for
/// eviction (docs/ENCRYPTION.md, "Attachment budget").
pub const DEFAULT_MEDIA_IDLE: Duration = Duration::from_secs(10 * 60);

fn is_media(relpath: &str) -> bool {
    MEDIA_PREFIXES.iter().any(|prefix| relpath.starts_with(prefix))
}

/// What's recorded at `runtime_dir/.restored-from` right after a restore (or
/// a crash-recovery sync), so the next launch can tell this runtime dir
/// apart from a stale or foreign one.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Marker {
    vault_id: String,
    generation: u64,
}

fn marker_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(MARKER_FILE_NAME)
}

fn read_marker(runtime_dir: &Path) -> Option<Marker> {
    let bytes = fs::read(marker_path(runtime_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_marker(runtime_dir: &Path, vault_id: &[u8; VAULT_ID_LEN], generation: u64) -> Result<(), Error> {
    let marker = Marker { vault_id: to_hex(vault_id), generation };
    let json = serde_json::to_vec(&marker)
        .map_err(|e| Error::new(crate::error::ErrorKind::Internal, format!("vault: couldn't encode the recovery marker: {e}")))?;
    write_secure_file(&marker_path(runtime_dir), &json)
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false)
}

fn wipe_runtime_dir(runtime_dir: &Path) -> Result<(), Error> {
    match fs::remove_dir_all(runtime_dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(runtime_dir, e)),
    }
}

fn do_restore(vault: &Vault, runtime_dir: &Path) -> Result<(), Error> {
    vault.restore(runtime_dir, |relpath| !is_media(relpath))?;
    sweep_non_allowlisted(runtime_dir)?;
    let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
    write_marker(runtime_dir, &vault.vault_id, manifest.generation)
}

/// Removes anything directly under `runtime_dir` that isn't one of
/// [`super::ALLOWED_TOP_DIRS`] (or the crash-recovery marker) — a restore
/// itself can never write such a thing (`Vault::restore` never restores a
/// non-allowlisted manifest entry), but this also covers the `Recovered`
/// path, where the runtime dir is reused as-is rather than restored into,
/// and any stray leftover from before `ALLOWED_TOP_DIRS` existed.
fn sweep_non_allowlisted(runtime_dir: &Path) -> Result<(), Error> {
    let entries = match fs::read_dir(runtime_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(runtime_dir, e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err(runtime_dir, e))?;
        let name = entry.file_name();
        if name == MARKER_FILE_NAME {
            continue;
        }
        let Some(name) = name.to_str() else {
            log::warn!("vault: sweep: skipping a non-UTF-8 entry under {}", runtime_dir.display());
            continue;
        };
        if super::ALLOWED_TOP_DIRS.contains(&name) {
            continue;
        }
        let path = entry.path();
        let result = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("vault: couldn't remove a stray non-allowlisted entry {}: {e}", path.display());
            }
        } else {
            log::warn!("vault: removed a stray non-allowlisted entry from the runtime dir: {}", path.display());
        }
    }
    Ok(())
}

/// What [`VaultSession::start`] found the runtime dir in. Exposed mainly for
/// logging and tests; task 4 doesn't need to branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartKind {
    /// Nothing usable was there: an ordinary restore.
    Fresh,
    /// A previous session of *this* vault crashed: the runtime dir's
    /// contents were synced into the vault before being reused as-is.
    Recovered,
    /// A runtime dir existed but wasn't recognizably this vault's (a
    /// foreign marker, or none at all): wiped, then restored fresh.
    Wiped,
}

/// What [`VaultSession::evict_media`] did.
#[derive(Debug, Clone, Default)]
pub struct EvictReport {
    /// Relpaths removed from the runtime dir, oldest-accessed first.
    pub evicted: Vec<String>,
    pub freed_bytes: u64,
    /// Total runtime media remaining after eviction.
    pub remaining_bytes: u64,
}

/// What [`VaultSession::start_or_return`] was given, handed back when it fails.
pub type StartParts = (Vault, PathBuf, InstanceLock);

/// Locks `m`, ignoring poisoning: everything these mutexes guard is a plain
/// map or a unit, left consistent at every point a panic could interrupt it.
fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The in-memory media bookkeeping, behind `Inner::state`.
#[derive(Default)]
struct MediaState {
    /// In-memory only, per docs/ENCRYPTION.md's "Attachment budget": lost on
    /// restart, which just means every media file looks freshly accessed
    /// again right after a restore — never a correctness problem, since
    /// `evict_media` only ever removes files already safely in the vault.
    last_access: HashMap<String, Instant>,
    /// Media relpaths this session knows are materialized in the runtime
    /// dir: seen present on a [`sync`](SessionHandle::sync)'s walk, or
    /// hydrated by [`ensure_media`](SessionHandle::ensure_media). Also
    /// in-memory only, lost on restart exactly like `last_access` — a fresh
    /// session has hydrated nothing yet, so starting empty is always
    /// correct, never a reason a real deletion could be missed
    /// (docs/ENCRYPTION.md, "Sync").
    ///
    /// `sync` consults this to tell a media relpath signal-cli genuinely
    /// deleted (materialized, now gone: drop it) from one this session
    /// simply hasn't hydrated yet (never materialized, still absent: keep
    /// it) — the fix for a real bug where the first sync after every launch
    /// treated every not-yet-hydrated media file as deleted and destroyed
    /// its blob. `evict_media` removes a relpath from this set the moment it
    /// deletes the file, so an evicted-then-re-hydrated file round-trips
    /// through "materialized → not materialized → materialized" exactly as
    /// its presence on disk does.
    materialized_media: HashSet<String>,
}

/// Everything a session shares between its handles. See [`SessionHandle`] for
/// what may run concurrently and why that's safe.
struct Inner {
    vault: Vault,
    runtime_dir: PathBuf,
    /// Held for the session's life; released when the last handle drops.
    _lock: InstanceLock,
    state: Mutex<MediaState>,
    /// What the last sync copied of each database, so one with writes still
    /// sitting in its WAL isn't mistaken for unchanged. Only ever touched
    /// under `maintenance`.
    db_prints: Mutex<sync::DbPrints>,
    /// Serialises everything that commits to the vault or deletes runtime
    /// media: [`SessionHandle::sync`], [`evict_media`](SessionHandle::evict_media),
    /// [`finish`](SessionHandle::finish) and [`quiesce`](SessionHandle::quiesce).
    /// A pass holds it from reading the manifest to the end of its garbage
    /// collection, which is what keeps manifest generations strictly linear.
    /// Hydration never takes it on the way in (that is the point).
    maintenance: Mutex<()>,
    /// `true` once the session is shut down or discarded. Hydration holds it
    /// shared for the whole of its work; closing takes it exclusively, so
    /// closing waits for hydrations in flight and no later one can write into
    /// a runtime dir that is being (or has been) wiped.
    closed: RwLock<bool>,
}

/// A cheap, cloneable, thread-safe handle on a running vault session.
///
/// Every method takes `&self`, so the caller needs no lock of its own around
/// the session, and in particular a long [`sync`](Self::sync) doesn't hold
/// anything a [`ensure_media`](Self::ensure_media) needs. The pieces:
///
/// - **`maintenance`** serialises sync, eviction and shutdown/discard.
/// - **`state`** (touch times, the materialized-media set) is held only for
///   map updates, never across I/O except eviction's single `unlink`.
/// - **`closed`** (see `Inner::closed`) fences hydration off from shutdown and
///   discard.
///
/// The interleavings, and why each is safe:
///
/// - *Hydration during a sync.* Hydration neither reads nor writes anything a
///   sync is in the middle of: it reads the manifest from disk (always a whole
///   generation, because [`manifest::commit`] renames), and writes the file
///   whole-or-not-at-all (temp name, then rename), so a sync's walk never sees
///   a partial file. The sync decides "deleted" from the materialized set as
///   it was *before* its walk, so a file hydrated after the walk is never
///   mistaken for a deleted one.
/// - *Hydrating a blob the sync garbage-collects.* GC keeps the current and
///   previous generation; a hydration that loaded an older manifest can find
///   its blob gone. Any hydration failure waits for the sync in flight (the
///   `maintenance` lock) and retries once against the settled vault: the
///   retry either finds the entry gone (reported as absent, as if it had been
///   deleted first) or the new blob, and a real corruption fails twice.
/// - *Hydrating while the first-ever sync has written blobs but no manifest.*
///   The manifest loader would call that "manifests missing, blobs remain";
///   the same wait-and-retry resolves it.
/// - *Eviction during hydration.* Hydration records the access before it
///   looks at the file; eviction re-checks the access time under the `state`
///   lock right before each `unlink`, and unlinks and updates the
///   materialized set in that one critical section. A file just hydrated or
///   touched is therefore skipped, and the materialized set always matches
///   the disk.
/// - *Shutdown or discard during a sync or hydration.* Both close the session
///   first (waiting out hydrations in flight, refusing new ones), then wait
///   for the sync's `maintenance` hold. Shutdown then runs its own final sync;
///   discard runs none. A sync that was still queued behind the lock sees
///   `closed` and does nothing, so nothing is written to a vault after an
///   erase, and no hydration can recreate the runtime dir once it is wiped.
#[derive(Clone)]
pub struct SessionHandle(Arc<Inner>);

impl SessionHandle {
    pub fn runtime_dir(&self) -> &Path {
        &self.0.runtime_dir
    }

    fn is_closed(&self) -> bool {
        *self.0.closed.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records `relpath` as just accessed, without restoring anything.
    /// [`ensure_media`](Self::ensure_media) calls this itself; exposed
    /// separately for a caller that reads a file without going through it
    /// (e.g. one it knows is already present).
    pub fn touch(&self, relpath: &str) {
        relock(&self.0.state).last_access.insert(relpath.to_string(), Instant::now());
    }

    /// [`touch`](Self::touch) and record `relpath` as materialized in one
    /// critical section, so eviction can't slip between the two and leave the
    /// set claiming a file it just removed.
    fn touch_and_mark(&self, relpath: &str) {
        let mut state = relock(&self.0.state);
        state.last_access.insert(relpath.to_string(), Instant::now());
        state.materialized_media.insert(relpath.to_string());
    }

    /// Syncs the runtime dir into the vault (docs/ENCRYPTION.md, "Sync",
    /// "When to sync"). Unlike [`Vault::sync`](super::Vault::sync), a media
    /// relpath absent from the runtime dir is only treated as deleted once
    /// this session has actually seen it materialized there. Does nothing on
    /// a closed session.
    pub fn sync(&self) -> Result<sync::SyncReport, Error> {
        let _pass = relock(&self.0.maintenance);
        if self.is_closed() {
            return Ok(sync::SyncReport::default());
        }
        self.sync_locked()
    }

    /// The body of a sync; the caller holds `maintenance`.
    fn sync_locked(&self) -> Result<sync::SyncReport, Error> {
        // What was materialized *before* the walk: a file hydrated after it
        // isn't in the walk, so must not count as known-and-deleted.
        let known = relock(&self.0.state).materialized_media.clone();
        let walked = sync::walk(&self.0.runtime_dir)?;
        {
            let mut state = relock(&self.0.state);
            for entry in &walked {
                if is_media(&entry.relpath) {
                    state.materialized_media.insert(entry.relpath.clone());
                }
            }
        }
        #[cfg(test)]
        sync::test_hooks::fire(&self.0.vault.dir, "walked", "");
        let mut prints = relock(&self.0.db_prints);
        sync::sync_walked_with(&self.0.vault, &walked, |relpath| is_media(relpath) && !known.contains(relpath), &mut prints)
    }

    /// Hydrates `relpath` into the runtime dir if it's missing there but
    /// present in the vault's manifest (docs/ENCRYPTION.md, "Attachment
    /// budget"): decrypts it in place, verified, exactly like a full
    /// restore verifies every entry. Returns whether it actually restored
    /// anything — `false` when the file was already there, when the
    /// manifest doesn't have it at all, and when the session is closed.
    /// Either way, a successful call (file present on return) counts as an
    /// access and, since the file is now known to be materialized, makes
    /// `relpath` safe for a later [`sync`](Self::sync) to delete if it later
    /// goes missing for real.
    ///
    /// Never waits for a sync on the way in. If the attempt fails in a way a
    /// settling vault could explain, it waits for any pass in flight and tries
    /// once more (see the type docs).
    pub fn ensure_media(&self, relpath: &str) -> Result<bool, Error> {
        validate_relpath(relpath)?;
        // Before anything else, so eviction can't pick the file in between.
        self.touch(relpath);
        match self.hydrate_once(relpath) {
            Ok(restored) => Ok(restored),
            // Only what a settling vault can fix is worth waiting for: the
            // manifest missing or mid-commit (`VaultCorrupt`) and a blob that
            // was collected (`VaultBlobCorrupt`). Anything else (a full or
            // unwritable runtime dir, say) can't be helped by a sync
            // finishing, so it fails at once instead of stalling behind one.
            Err(e) if matches!(e.kind, ErrorKind::VaultCorrupt | ErrorKind::VaultBlobCorrupt) => {
                drop(relock(&self.0.maintenance));
                self.hydrate_once(relpath)
            }
            Err(e) => Err(e),
        }
    }

    fn hydrate_once(&self, relpath: &str) -> Result<bool, Error> {
        let closed = self.0.closed.read().unwrap_or_else(PoisonError::into_inner);
        if *closed {
            return Ok(false);
        }
        let full = self.0.runtime_dir.join(relpath);
        if full.is_file() {
            self.touch_and_mark(relpath);
            return Ok(false);
        }
        let restored = restore::restore_one(&self.0.vault, &self.0.runtime_dir, relpath)?;
        if restored {
            self.touch_and_mark(relpath);
        }
        Ok(restored)
    }

    /// Evicts already-synced, idle media once the runtime media total
    /// exceeds `budget_bytes` (docs/ENCRYPTION.md, "Attachment budget"):
    /// oldest-accessed first, stopping as soon as the total is back under
    /// budget. A media file is only ever a candidate if it's tracked in the
    /// current manifest with matching size, mtime and sha256 — an unsynced
    /// file (new, or changed since the last sync) is never evicted, no
    /// matter how idle it looks. Meant to run right after a
    /// [`sync`](Self::sync), so "already in the manifest" means "safe to
    /// delete and re-hydrate later". Does nothing on a closed session.
    pub fn evict_media(&self, budget_bytes: u64, idle: Duration) -> Result<EvictReport, Error> {
        let _pass = relock(&self.0.maintenance);
        if self.is_closed() {
            return Ok(EvictReport::default());
        }
        let vault = &self.0.vault;
        let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
        let entries = sync::walk(&self.0.runtime_dir)?;
        let media: Vec<&WalkEntry> = entries.iter().filter(|e| is_media(&e.relpath)).collect();

        let total: u64 = media.iter().map(|e| e.len).sum();
        if total <= budget_bytes {
            return Ok(EvictReport { evicted: Vec::new(), freed_bytes: 0, remaining_bytes: total });
        }

        let now = Instant::now();
        let last_access = relock(&self.0.state).last_access.clone();
        let mut candidates = Vec::new();
        for entry in &media {
            if !idle_enough(last_access.get(&entry.relpath).copied(), now, idle) {
                continue;
            }
            if is_synced(manifest.entries.get(&entry.relpath), entry)? {
                candidates.push(*entry);
            }
        }
        // Oldest access first; never-accessed-this-session sorts first
        // (`None < Some(_)`), matching "restored a while ago and never
        // touched since" being at least as evictable as any recorded access.
        candidates.sort_by_key(|e| last_access.get(&e.relpath).copied());

        let mut remaining = total;
        let mut evicted = Vec::new();
        let mut freed = 0u64;
        for entry in candidates {
            if remaining <= budget_bytes {
                break;
            }
            #[cfg(test)]
            sync::test_hooks::fire(&vault.dir, "evict-remove", &entry.relpath);
            // The candidate list is a snapshot; a hydration may have touched
            // this file since. Re-check, and unlink plus bookkeeping, as one
            // critical section against `touch`.
            let mut state = relock(&self.0.state);
            if !idle_enough(state.last_access.get(&entry.relpath).copied(), Instant::now(), idle) {
                continue;
            }
            fs::remove_file(&entry.path).map_err(|e| io_err(&entry.path, e))?;
            state.last_access.remove(&entry.relpath);
            // No longer materialized: the next sync must not treat its
            // absence as a real deletion (docs/ENCRYPTION.md, "Sync").
            state.materialized_media.remove(&entry.relpath);
            drop(state);
            remaining -= entry.len;
            freed += entry.len;
            evicted.push(entry.relpath.clone());
        }

        Ok(EvictReport { evicted, freed_bytes: freed, remaining_bytes: remaining })
    }

    /// Marks the session closed: waits for hydrations in flight, and makes
    /// every later hydration, sync and eviction a no-op.
    fn close(&self) {
        *self.0.closed.write().unwrap_or_else(PoisonError::into_inner) = true;
        #[cfg(test)]
        sync::test_hooks::fire(&self.0.vault.dir, "closed", "");
    }

    /// Closes the session and waits for a sync or eviction in flight, without
    /// syncing anything itself. For discarding a session (erase): the caller
    /// then wipes the runtime dir knowing nothing else can touch it or the
    /// vault.
    pub fn quiesce(&self) {
        self.close();
        drop(relock(&self.0.maintenance));
    }

    /// A final sync, then wipes the runtime dir. Closes the session first and
    /// waits for any sync or eviction in flight. If the sync fails, the
    /// runtime dir is deliberately left alone — it's still there for the
    /// next launch's crash recovery — and the error is returned; the session
    /// stays closed either way, and the instance lock is released once the
    /// last handle drops. That's harmless: a marker matching this vault is
    /// exactly what makes the next `start` take the recovery path instead of
    /// restoring over unsynced changes.
    pub fn finish(&self) -> Result<(), Error> {
        self.close();
        let _pass = relock(&self.0.maintenance);
        self.sync_locked()?;
        wipe_runtime_dir(&self.0.runtime_dir)
    }
}

fn idle_enough(accessed: Option<Instant>, now: Instant, idle: Duration) -> bool {
    match accessed {
        Some(t) => now.duration_since(t) >= idle,
        None => true,
    }
}

/// Ties a [`Vault`], its RAM-backed runtime dir and the process-wide
/// [`InstanceLock`] together for the lifetime of one signal-cli run. Owns the
/// session; [`handle`](Self::handle) gives out the thread-safe view that the
/// vault bridge shares between the sync loop and media hydration.
pub struct VaultSession {
    handle: SessionHandle,
    last_start: StartKind,
}

impl VaultSession {
    /// Starts a session for `vault` against `runtime_dir`, having already
    /// taken `lock` (see [`InstanceLock::acquire`]).
    ///
    /// - A `.restored-from` marker whose vault id matches `vault`'s means
    ///   the previous session of *this* vault crashed and the runtime dir
    ///   is newer than the vault: it's synced in first, then reused as-is
    ///   (no restore over it).
    /// - A marker for a different vault, or a non-empty runtime dir with no
    ///   marker at all, is wiped (it's RAM-only, so nothing is lost that
    ///   matters) and then restored fresh.
    /// - Anything else (nothing there yet) is restored fresh.
    ///
    /// Either way, media (`MEDIA_PREFIXES`) is excluded from the restore
    /// and left to [`ensure_media`](Self::ensure_media).
    pub fn start(vault: Vault, runtime_dir: PathBuf, lock: InstanceLock) -> Result<Self, Error> {
        Self::start_or_return(vault, runtime_dir, lock).map_err(|(error, _)| error)
    }

    /// [`start`](Self::start), but a failure hands back what it was given, so
    /// the caller still holds the instance lock (and can try again) rather
    /// than losing it with the error.
    pub fn start_or_return(
        vault: Vault,
        runtime_dir: PathBuf,
        lock: InstanceLock,
    ) -> Result<Self, (Error, Box<StartParts>)> {
        match Self::prepare(&vault, &runtime_dir) {
            Ok(kind) => Ok(Self {
                handle: SessionHandle(Arc::new(Inner {
                    vault,
                    runtime_dir,
                    _lock: lock,
                    state: Mutex::new(MediaState::default()),
                    db_prints: Mutex::new(sync::DbPrints::new()),
                    maintenance: Mutex::new(()),
                    closed: RwLock::new(false),
                })),
                last_start: kind,
            }),
            Err(error) => Err((error, Box::new((vault, runtime_dir, lock)))),
        }
    }

    /// Everything [`start`](Self::start) does that can fail, borrowing its inputs.
    fn prepare(vault: &Vault, runtime_dir: &Path) -> Result<StartKind, Error> {
        // Clean up any manifest entry left over from before `ALLOWED_TOP_DIRS`
        // existed — in particular one pointing at an installed signal-cli
        // binary rather than its data (docs/ENCRYPTION.md, "Migration") —
        // right at the start of every session rather than waiting on
        // ordinary sync activity to notice it's gone from the runtime dir.
        match vault.purge_non_allowlisted() {
            Ok(0) => {}
            Ok(removed) => log::info!("vault: purged {removed} non-allowlisted manifest entr(y/ies) and their blobs."),
            Err(e) => log::warn!("vault: couldn't purge non-allowlisted manifest entries: {e}"),
        }

        let marker = read_marker(runtime_dir);
        let matches_vault =
            marker.as_ref().and_then(|m| from_hex(&m.vault_id)).is_some_and(|id| id.as_slice() == vault.vault_id.as_slice());

        let kind = if marker.is_some() && matches_vault {
            StartKind::Recovered
        } else if marker.is_some() || dir_has_entries(runtime_dir) {
            StartKind::Wiped
        } else {
            StartKind::Fresh
        };

        match kind {
            StartKind::Recovered => {
                // No `VaultSession` exists yet, so there's no materialized-
                // media set to consult — and none is needed: a crashed
                // previous session's runtime dir was never restored into
                // either (same `do_restore` skips media as every other
                // start), so a media relpath missing here is exactly as
                // likely to be "never hydrated" as "really deleted", and
                // this path has no way to tell them apart. Keep every
                // absent media entry unconditionally; an ordinary sync once
                // the session exists can tell the difference and will catch
                // up on a real deletion then.
                sync::sync(vault, runtime_dir, is_media)?;
                sweep_non_allowlisted(runtime_dir)?;
                let (manifest, _source) = manifest::load_with_fallback(&vault.dir, &vault.key, &vault.vault_id)?;
                write_marker(runtime_dir, &vault.vault_id, manifest.generation)?;
            }
            StartKind::Wiped | StartKind::Fresh => {
                wipe_runtime_dir(runtime_dir)?;
                do_restore(vault, runtime_dir)?;
            }
        }

        Ok(kind)
    }

    /// What [`start`](Self::start) found, for logging/tests.
    pub fn last_start(&self) -> StartKind {
        self.last_start
    }

    pub fn runtime_dir(&self) -> &Path {
        self.handle.runtime_dir()
    }

    /// A shared handle on this session. Handles keep the instance lock alive,
    /// so the lock is released only once the session and every handle are gone.
    pub fn handle(&self) -> SessionHandle {
        self.handle.clone()
    }

    /// Consumes the session into its shared handle, for a caller that only
    /// ever uses the thread-safe interface.
    pub fn into_handle(self) -> SessionHandle {
        self.handle
    }

    /// See [`SessionHandle::sync`].
    pub fn sync(&mut self) -> Result<sync::SyncReport, Error> {
        self.handle.sync()
    }

    /// See [`SessionHandle::touch`].
    pub fn touch(&mut self, relpath: &str) {
        self.handle.touch(relpath);
    }

    /// See [`SessionHandle::ensure_media`].
    pub fn ensure_media(&mut self, relpath: &str) -> Result<bool, Error> {
        self.handle.ensure_media(relpath)
    }

    /// See [`SessionHandle::evict_media`].
    pub fn evict_media(&mut self, budget_bytes: u64, idle: Duration) -> Result<EvictReport, Error> {
        self.handle.evict_media(budget_bytes, idle)
    }

    /// A final sync, then wipes the runtime dir and releases the instance
    /// lock (see [`SessionHandle::finish`], which this wraps; the lock is
    /// released here as long as no [`handle`](Self::handle) is still alive).
    pub fn shutdown(self) -> Result<(), Error> {
        self.handle.finish()
    }
}

/// Whether `entry` (a real runtime file) matches the manifest entry for its
/// relpath closely enough to be deleted without losing data: same size and
/// mtime first (cheap), then — only if those match — the same content hash.
/// `Ok(false)` (never evictable) if there's no manifest entry at all.
fn is_synced(manifest_entry: Option<&ManifestEntry>, entry: &WalkEntry) -> Result<bool, Error> {
    let Some(manifest_entry) = manifest_entry else {
        return Ok(false);
    };
    if manifest_entry.size != entry.len || manifest_entry.mtime_ns != entry.mtime_ns {
        return Ok(false);
    }
    let bytes = fs::read(&entry.path).map_err(|e| io_err(&entry.path, e))?;
    Ok(to_hex(&Sha256::digest(&bytes)) == manifest_entry.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::Key32;
    use crate::error::ErrorKind;
    use crate::vault::VAULT_ID_LEN;
    use std::fs;
    use tempfile::TempDir;

    /// Removed on drop (rather than left under `/tmp/snowdrop-*` forever).
    fn temp_dir(name: &str) -> TempDir {
        tempfile::Builder::new().prefix(&format!("snowdrop-vault-session-test-{}-{name}-", std::process::id())).tempdir().unwrap()
    }

    fn new_vault(base: &Path, vault_id: [u8; VAULT_ID_LEN]) -> Vault {
        Vault::open(&base.join("vault"), Key32::random(), vault_id).unwrap()
    }

    fn lock(base: &Path) -> InstanceLock {
        InstanceLock::acquire(&base.join("app-data")).unwrap()
    }

    fn write_file(dir: &Path, relpath: &str, contents: &[u8]) {
        let path = dir.join(relpath);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
    }

    #[test]
    fn fresh_start_restores_and_writes_a_marker() {
        let base = temp_dir("fresh");
        let base = base.path();
        let vault = new_vault(base, [1u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Fresh);
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"account data");
        assert!(read_marker(&runtime).is_some());
    }

    #[test]
    fn media_is_excluded_from_restore_then_hydrated_on_demand() {
        let base = temp_dir("media");
        let base = base.path();
        let vault = new_vault(base, [2u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(runtime.join("data/account").exists());
        assert!(!runtime.join("attachments/photo.jpg").exists(), "media must not be restored up front");

        let restored = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(restored);
        assert_eq!(fs::read(runtime.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");

        // Second call: already present, nothing to do.
        let restored_again = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(!restored_again);

        // Not in the manifest at all.
        let missing = session.ensure_media("attachments/nope.jpg").unwrap();
        assert!(!missing);
    }

    // The regression suite for a real data-loss bug: `sync` used to treat
    // *every* manifest entry absent from the runtime dir as deleted, which
    // meant the first sync after any launch (media is never restored up
    // front) — or any sync after `evict_media` — permanently destroyed
    // every attachment, avatar and sticker that wasn't hydrated at that
    // exact moment. These five tests pin down the fix: a media relpath is
    // only ever dropped once this session has actually seen it
    // materialized and it then goes missing for real; a non-media relpath
    // is unaffected either way.

    #[test]
    fn fresh_start_sync_does_not_delete_unhydrated_media() {
        let base = temp_dir("media-fresh-sync");
        let base = base.path();
        let vault = new_vault(base, [20u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(!runtime.join("attachments/photo.jpg").exists(), "media must not be restored up front");

        // The very first sync of a fresh session must not treat the
        // never-hydrated attachment as deleted, even though it's genuinely
        // absent from the runtime dir right now.
        let report = session.sync().unwrap();
        assert_eq!(report.deleted, 0, "sync must not count unhydrated media as deleted");
        assert!(!report.wrote, "nothing actually changed, so nothing should be committed");

        let restored = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(restored, "the manifest entry must have survived the sync above");
        assert_eq!(fs::read(runtime.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");
    }

    #[test]
    fn evicted_media_survives_a_subsequent_sync() {
        let base = temp_dir("media-evict-sync");
        let base = base.path();
        let vault = new_vault(base, [21u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(session.ensure_media("attachments/photo.jpg").unwrap());

        // Budget 0, idle 0: evicts everything already synced, regardless of
        // how recently it was accessed.
        let evict_report = session.evict_media(0, Duration::ZERO).unwrap();
        assert_eq!(evict_report.evicted, vec!["attachments/photo.jpg".to_string()]);
        assert!(!runtime.join("attachments/photo.jpg").exists());

        let sync_report = session.sync().unwrap();
        assert_eq!(sync_report.deleted, 0, "a file this session itself evicted must not be treated as deleted");

        let restored = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(restored, "the manifest entry must have survived the sync above");
        assert_eq!(fs::read(runtime.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");
    }

    #[test]
    fn sync_drops_media_actually_deleted_after_being_materialized() {
        let base = temp_dir("media-real-delete");
        let base = base.path();
        let vault = new_vault(base, [22u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");

        // Written straight into the running session's runtime dir (rather
        // than via `ensure_media`) and synced, the same way signal-cli
        // itself would create a new attachment: the sync's own walk sees it
        // present, which is what marks it materialized.
        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        session.sync().unwrap();

        // signal-cli (simulated) really deletes the file.
        fs::remove_file(runtime.join("attachments/photo.jpg")).unwrap();
        let report = session.sync().unwrap();
        assert_eq!(report.deleted, 1, "a materialized-then-missing media file is a real deletion");

        // Gone from the manifest for good: re-hydrating it finds nothing.
        let restored = session.ensure_media("attachments/photo.jpg").unwrap();
        assert!(!restored);
    }

    #[test]
    fn crash_recovery_keeps_media_absent_from_the_runtime_dir() {
        let base = temp_dir("media-crash-recovery");
        let base = base.path();
        let vault_id = [23u8; VAULT_ID_LEN];
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let runtime = base.join("runtime");

        let vault1 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        write_file(&runtime, "data/account", b"account data");
        write_file(&runtime, "attachments/photo.jpg", b"fake jpeg bytes");
        vault1.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session1 = VaultSession::start(vault1, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session1.last_start(), StartKind::Fresh);
        assert!(!runtime.join("attachments/photo.jpg").exists(), "media never restored up front");

        // "Crash": dropped without calling `shutdown`, same as the existing
        // crash-recovery test — the attachment is still never hydrated.
        drop(session1);

        let vault2 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let session2 = VaultSession::start(vault2, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session2.last_start(), StartKind::Recovered);

        // The crash-recovery sync (which runs in `start`, before any
        // `VaultSession` exists to track materialized media) must not have
        // treated the never-hydrated attachment as deleted.
        let check_vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let restored = temp_dir("media-crash-recovery-restored");
        let restored = restored.path();
        check_vault.restore(restored, |_| true).unwrap();
        assert_eq!(fs::read(restored.join("attachments/photo.jpg")).unwrap(), b"fake jpeg bytes");
    }

    #[test]
    fn sync_still_drops_a_deleted_non_media_file() {
        let base = temp_dir("non-media-delete");
        let base = base.path();
        let vault = new_vault(base, [24u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"account data");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(runtime.join("data/account").exists());

        fs::remove_file(runtime.join("data/account")).unwrap();
        let report = session.sync().unwrap();
        assert_eq!(report.deleted, 1, "a non-media relpath missing from the runtime dir is still always a real deletion");
    }

    #[test]
    fn crash_recovery_syncs_the_modification_and_keeps_the_runtime_dir() {
        let base = temp_dir("crash");
        let base = base.path();
        let vault_id = [3u8; VAULT_ID_LEN];
        let vault_dir = base.join("vault");
        let key = Key32::random();
        let runtime = base.join("runtime");

        let vault1 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        write_file(&runtime, "data/account", b"original");
        vault1.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session1 = VaultSession::start(vault1, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session1.last_start(), StartKind::Fresh);

        // signal-cli (simulated) keeps writing; the process then "crashes":
        // dropped without calling `shutdown`, so no final sync and the lock
        // is simply released by the fd closing.
        fs::write(runtime.join("data/account"), b"modified after start, never synced").unwrap();
        drop(session1);

        let vault2 = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let session2 = VaultSession::start(vault2, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session2.last_start(), StartKind::Recovered);
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"modified after start, never synced");

        // And it really did make it into the vault, not just stay on disk:
        // a fresh restore elsewhere must see the modification too.
        let check_vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let restored_elsewhere = temp_dir("crash-restored-elsewhere");
        let restored_elsewhere = restored_elsewhere.path();
        check_vault.restore(restored_elsewhere, |_| true).unwrap();
        assert_eq!(fs::read(restored_elsewhere.join("data/account")).unwrap(), b"modified after start, never synced");
    }

    #[test]
    fn a_foreign_marker_gets_wiped_not_recovered() {
        let base = temp_dir("foreign");
        let base = base.path();
        let vault = new_vault(base, [4u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"vault content");
        vault.sync(&runtime).unwrap();
        // Clear the vault's own marker and plant one for a different vault,
        // plus an unrelated leftover file that must not survive the wipe.
        let _ = fs::remove_file(marker_path(&runtime));
        write_marker(&runtime, &[0xffu8; VAULT_ID_LEN], 1).unwrap();
        write_file(&runtime, "stray.txt", b"leftover from somewhere else");

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Wiped);
        assert!(!runtime.join("stray.txt").exists());
        assert_eq!(fs::read(runtime.join("data/account")).unwrap(), b"vault content");
    }

    #[test]
    fn a_runtime_dir_with_no_marker_at_all_gets_wiped() {
        let base = temp_dir("no-marker");
        let base = base.path();
        let vault = new_vault(base, [5u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"vault content");
        vault.sync(&runtime).unwrap();
        // `vault.sync` alone never writes a marker (only `VaultSession::start`
        // does) — this directory is exactly "content with no marker at all".
        write_file(&runtime, "stray.txt", b"no marker, no trust");

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert_eq!(session.last_start(), StartKind::Wiped);
        assert!(!runtime.join("stray.txt").exists());
    }

    #[test]
    fn eviction_respects_budget_idle_and_the_unsynced_rule() {
        let base = temp_dir("evict");
        let base = base.path();
        let vault = new_vault(base, [6u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");

        // Start with nothing to restore, then write media straight into the
        // running session's runtime dir and sync it: that's the only way to
        // get a manifest entry whose recorded mtime exactly matches the
        // real file's mtime, which `is_synced` requires.
        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        write_file(&runtime, "attachments/old.bin", &[0u8; 100]);
        write_file(&runtime, "attachments/recent.bin", &[0u8; 100]);
        session.sync().unwrap();

        // `recent.bin` was just "accessed"; `old.bin` never was this session.
        session.touch("attachments/recent.bin");
        // Created after the sync above: present on disk, but not in the
        // manifest at all, so it must never be evicted.
        write_file(&runtime, "attachments/unsynced.bin", &[0u8; 100]);

        let report = session.evict_media(100, Duration::from_secs(600)).unwrap();
        assert_eq!(report.evicted, vec!["attachments/old.bin".to_string()]);
        assert_eq!(report.freed_bytes, 100);
        assert!(!runtime.join("attachments/old.bin").exists());
        assert!(runtime.join("attachments/recent.bin").exists(), "recently accessed, must survive");
        assert!(runtime.join("attachments/unsynced.bin").exists(), "never synced, must never be evicted");
    }

    #[test]
    fn eviction_is_a_no_op_under_budget() {
        let base = temp_dir("evict-under-budget");
        let base = base.path();
        let vault = new_vault(base, [7u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        write_file(&runtime, "attachments/a.bin", &[0u8; 10]);
        session.sync().unwrap();

        let report = session.evict_media(1_000_000, Duration::ZERO).unwrap();
        assert!(report.evicted.is_empty());
        assert!(runtime.join("attachments/a.bin").exists());
    }

    #[test]
    fn shutdown_syncs_then_wipes_and_releases_the_lock() {
        let base = temp_dir("shutdown-ok");
        let base = base.path();
        let vault = new_vault(base, [8u8; VAULT_ID_LEN]);
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"v1");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        fs::write(runtime.join("data/account"), b"v2, synced on shutdown").unwrap();
        session.shutdown().unwrap();

        assert!(!runtime.exists(), "runtime dir must be wiped after a clean shutdown");
        // The lock was released: a new acquisition over the same app data
        // dir must succeed.
        let _relocked = lock(base);
    }

    #[test]
    fn shutdown_keeps_the_runtime_dir_when_the_final_sync_fails() {
        let base = temp_dir("shutdown-fail");
        let base = base.path();
        let vault = new_vault(base, [9u8; VAULT_ID_LEN]);
        let vault_dir = base.join("vault");
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"v1");
        vault.sync(&runtime).unwrap();

        let session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();

        // Corrupt both manifest generations so the final sync's own
        // `load_with_fallback` fails with `VaultCorrupt`.
        fs::write(vault_dir.join("manifest"), b"not sealed data").unwrap();
        fs::write(vault_dir.join("manifest.prev"), b"also not sealed data").unwrap();

        let err = session.shutdown().unwrap_err();
        assert_eq!(err.kind, ErrorKind::VaultCorrupt);
        assert!(runtime.exists(), "the runtime dir must survive a failed final sync, for crash recovery");
        assert!(runtime.join("data/account").exists());
    }

    #[test]
    fn the_marker_is_never_synced_into_the_vault() {
        let base = temp_dir("marker-not-synced");
        let base = base.path();
        let vault_id = [10u8; VAULT_ID_LEN];
        let key = Key32::random();
        let vault_dir = base.join("vault");
        let vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let runtime = base.join("runtime");
        write_file(&runtime, "data/account", b"content");
        vault.sync(&runtime).unwrap();
        fs::remove_dir_all(&runtime).unwrap();

        let mut session = VaultSession::start(vault, runtime.clone(), lock(base)).unwrap();
        assert!(read_marker(&runtime).is_some(), "sanity: the marker really is on disk");
        session.sync().unwrap();

        // Reopen the same vault (same key) to check its contents directly,
        // since `session` now owns the original `Vault` value.
        let check_vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
        let restored = temp_dir("marker-not-synced-restored");
        let restored = restored.path();
        check_vault.restore(restored, |_| true).unwrap();
        assert!(!restored.join(MARKER_FILE_NAME).exists());
    }

    // Concurrency: media hydration runs while a sync or an eviction is in
    // flight (see `SessionHandle`'s docs for the reasoning behind each).

    use crate::vault::test_hooks;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    const WAIT: Duration = Duration::from_secs(10);

    struct Fx {
        _base: TempDir,
        handle: SessionHandle,
        runtime: PathBuf,
        vault_dir: PathBuf,
        key: Vec<u8>,
        vault_id: [u8; VAULT_ID_LEN],
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            test_hooks::clear(&self.vault_dir);
        }
    }

    impl Fx {
        /// Everything in `seed` is synced into the vault, then a session starts
        /// on a fresh runtime dir (so seeded media isn't hydrated yet).
        fn start(name: &str, id: u8, seed: &[(&str, &[u8])]) -> Fx {
            let base = temp_dir(name);
            let vault_id = [id; VAULT_ID_LEN];
            let key = Key32::random();
            let vault_dir = base.path().join("vault");
            let runtime = base.path().join("runtime");
            let vault = Vault::open(&vault_dir, Key32::from_slice(key.as_bytes()).unwrap(), vault_id).unwrap();
            for (relpath, contents) in seed {
                write_file(&runtime, relpath, contents);
            }
            vault.sync(&runtime).unwrap();
            let _ = fs::remove_dir_all(&runtime);
            let handle = VaultSession::start(vault, runtime.clone(), lock(base.path())).unwrap().into_handle();
            Fx { handle, runtime, vault_dir, key: key.as_bytes().to_vec(), vault_id, _base: base }
        }

        fn restored_elsewhere(&self, name: &str) -> TempDir {
            let vault = Vault::open(&self.vault_dir, Key32::from_slice(&self.key).unwrap(), self.vault_id).unwrap();
            let out = temp_dir(name);
            vault.restore(out.path(), |_| true).unwrap();
            out
        }
    }

    /// The blob a hydration is about to read is garbage-collected by two syncs
    /// that happen after it loaded the manifest. It must settle as "gone", not
    /// fail with a missing-blob error.
    #[test]
    fn hydration_whose_blob_is_collected_underneath_it_settles_cleanly() {
        let fx = Fx::start("conc-gc", 40, &[("data/account", b"v1"), ("attachments/m.bin", b"media bytes")]);
        let m = "attachments/m.bin";
        assert!(fx.handle.ensure_media(m).unwrap());
        // signal-cli really deletes it: materialized, then gone.
        fs::remove_file(fx.runtime.join(m)).unwrap();

        let mut park = test_hooks::park_at(&fx.vault_dir, "hydrate-manifest");
        let hydrating = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.ensure_media(m))
        };
        assert!(park.wait_entered(WAIT), "the hydration never got as far as the manifest");

        // Generation +1 drops the entry, generation +2 collects its blob.
        assert_eq!(fx.handle.sync().unwrap().deleted, 1);
        fs::write(fx.runtime.join("data/account"), b"v2, longer").unwrap();
        assert!(fx.handle.sync().unwrap().removed_blobs >= 1);

        park.release();
        let result = hydrating.join().unwrap();
        assert!(!result.expect("a collected blob must settle, not fail"), "nothing to restore: it was deleted first");
        assert!(!fx.runtime.join(m).exists());
    }

    /// A hydration that runs while the very first sync has written blobs but
    /// not yet its manifest used to see "manifests missing, blobs remain". It
    /// waits for the sync instead of failing.
    #[test]
    fn hydration_during_the_first_ever_sync_waits_instead_of_failing() {
        let fx = Fx::start("conc-first-sync", 41, &[]);
        write_file(&fx.runtime, "data/account", b"first data");
        let mut park = test_hooks::park_at(&fx.vault_dir, "commit");
        let syncing = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.sync())
        };
        assert!(park.wait_entered(WAIT));

        let (tx, rx) = mpsc::channel();
        let hydrating = {
            let handle = fx.handle.clone();
            thread::spawn(move || tx.send(handle.ensure_media("attachments/x.bin")).unwrap())
        };
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "the failed attempt should be waiting for the sync");
        park.release();
        assert!(!rx.recv_timeout(WAIT).unwrap().expect("must not report corruption"));
        hydrating.join().unwrap();
        assert!(syncing.join().unwrap().unwrap().wrote);
    }

    /// A hydration that lands between eviction picking its candidates and
    /// unlinking one must win: the file stays.
    #[test]
    fn eviction_skips_a_file_hydration_touched_after_it_was_picked() {
        let fx = Fx::start("conc-evict", 42, &[]);
        write_file(&fx.runtime, "attachments/a.bin", &[7u8; 100]);
        fx.handle.sync().unwrap();

        let mut park = test_hooks::park_at(&fx.vault_dir, "evict-remove");
        let evicting = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.evict_media(0, Duration::from_secs(600)))
        };
        assert!(park.wait_entered(WAIT));
        // Doesn't wait for the parked eviction (it holds the maintenance lock).
        let (tx, rx) = mpsc::channel();
        {
            let handle = fx.handle.clone();
            thread::spawn(move || tx.send(handle.ensure_media("attachments/a.bin")).unwrap());
        }
        assert!(!rx.recv_timeout(WAIT).expect("hydration must not wait for the eviction").unwrap());
        park.release();
        let report = evicting.join().unwrap().unwrap();
        assert!(report.evicted.is_empty(), "a just-touched file must not be evicted");
        assert!(fx.runtime.join("attachments/a.bin").exists());
    }

    /// A file hydrated after the sync's walk isn't in the walk, but isn't
    /// deleted either: its manifest entry must survive.
    #[test]
    fn a_file_hydrated_after_the_walk_is_not_treated_as_deleted() {
        let fx = Fx::start("conc-walk", 43, &[("data/account", b"v1"), ("attachments/m.bin", b"media bytes")]);
        let mut park = test_hooks::park_at(&fx.vault_dir, "walked");
        let syncing = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.sync())
        };
        assert!(park.wait_entered(WAIT));
        let (tx, rx) = mpsc::channel();
        {
            let handle = fx.handle.clone();
            thread::spawn(move || tx.send(handle.ensure_media("attachments/m.bin")).unwrap());
        }
        assert!(rx.recv_timeout(WAIT).expect("hydration must not wait for the sync").unwrap());
        park.release();
        assert_eq!(syncing.join().unwrap().unwrap().deleted, 0);

        fs::remove_file(fx.runtime.join("attachments/m.bin")).unwrap();
        assert!(fx.handle.ensure_media("attachments/m.bin").unwrap(), "the manifest entry must have survived");
    }

    /// Hydration leaves no half-written file for a walk to find, and no
    /// temporary behind.
    #[test]
    fn hydration_leaves_no_temporary_file_behind() {
        let fx = Fx::start("conc-tmp", 44, &[("attachments/m.bin", b"media bytes")]);
        assert!(fx.handle.ensure_media("attachments/m.bin").unwrap());
        let strays: Vec<_> = fs::read_dir(&fx.runtime).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".hydrate")).collect();
        assert!(strays.is_empty(), "{strays:?}");
        assert_eq!(fs::read(fx.runtime.join("attachments/m.bin")).unwrap(), b"media bytes");
    }

    /// signal-cli's database takes its writes in the `-wal` file, leaving the
    /// `.db`'s own size and mtime alone until a checkpoint; those writes must
    /// still be synced, once, and an idle WAL must not be copied again.
    #[test]
    fn a_wal_only_change_is_synced_and_an_idle_wal_is_not_recopied() {
        let fx = Fx::start("conc-wal", 45, &[]);
        let copies = test_hooks::record(&fx.vault_dir, "copy");
        let db_copies = || copies.lock().unwrap().iter().filter(|p| p.ends_with("account.db")).count();

        let db = rusqlite::Connection::open({
            fs::create_dir_all(fx.runtime.join("data")).unwrap();
            fx.runtime.join("data/account.db")
        })
        .unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE msgs (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        db.execute("INSERT INTO msgs (body) VALUES ('a')", []).unwrap();
        assert!(fx.handle.sync().unwrap().wrote);
        assert_eq!(db_copies(), 1);

        // Committed to the WAL only: the .db file itself is untouched.
        db.execute("INSERT INTO msgs (body) VALUES ('b')", []).unwrap();
        let report = fx.handle.sync().unwrap();
        assert!(report.wrote && report.changed == 1, "a change sitting in the WAL was missed");
        assert_eq!(db_copies(), 2);

        // Nothing changed since: no copy at all.
        let report = fx.handle.sync().unwrap();
        assert!(!report.wrote);
        assert_eq!(db_copies(), 2, "an unchanged database was copied again");

        db.execute("INSERT INTO msgs (body) VALUES ('c')", []).unwrap();
        fx.handle.sync().unwrap();
        assert_eq!(db_copies(), 3);

        let restored = fx.restored_elsewhere("conc-wal-restored");
        let check = rusqlite::Connection::open(restored.path().join("data/account.db")).unwrap();
        let bodies: Vec<String> = check.prepare("SELECT body FROM msgs ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(bodies, ["a", "b", "c"]);
    }

    /// A non-WAL database (or any plain file) is skipped on size+mtime alone.
    #[test]
    fn an_unchanged_plain_file_is_not_copied_and_a_changed_one_is() {
        let fx = Fx::start("conc-plain", 46, &[]);
        let copies = test_hooks::record(&fx.vault_dir, "copy");
        write_file(&fx.runtime, "data/account", b"one");
        fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 1);
        fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 1, "an unchanged file was copied again");
        fs::write(fx.runtime.join("data/account"), b"two, longer").unwrap();
        fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 2);
    }

    /// Once a session is closed (shutdown or erase) nothing may write to the
    /// vault or the runtime dir any more.
    #[test]
    fn a_closed_session_syncs_nothing_and_hydrates_nothing() {
        let fx = Fx::start("conc-closed", 47, &[("data/account", b"v1"), ("attachments/m.bin", b"media bytes")]);
        fx.handle.quiesce();
        fs::write(fx.runtime.join("data/account"), b"changed after close").unwrap();
        assert!(!fx.handle.sync().unwrap().wrote);
        assert!(fx.handle.evict_media(0, Duration::ZERO).unwrap().evicted.is_empty());
        assert!(!fx.handle.ensure_media("attachments/m.bin").unwrap());
        assert!(!fx.runtime.join("attachments/m.bin").exists());
        let restored = fx.restored_elsewhere("conc-closed-restored");
        assert_eq!(fs::read(restored.path().join("data/account")).unwrap(), b"v1");
    }

    #[test]
    fn hydration_after_shutdown_does_not_recreate_the_runtime_dir() {
        let fx = Fx::start("conc-after-finish", 48, &[("data/account", b"v1"), ("attachments/m.bin", b"media bytes")]);
        fs::write(fx.runtime.join("data/account"), b"v2, synced by the final pass").unwrap();
        fx.handle.finish().unwrap();
        assert!(!fx.runtime.exists());
        assert!(!fx.handle.ensure_media("attachments/m.bin").unwrap());
        assert!(!fx.runtime.exists(), "a late hydration put plaintext back after the wipe");
        let restored = fx.restored_elsewhere("conc-after-finish-restored");
        assert_eq!(fs::read(restored.path().join("data/account")).unwrap(), b"v2, synced by the final pass");
    }

    /// Shutdown while a sync is mid-pass waits for it, then syncs and wipes.
    #[test]
    fn finish_waits_for_a_running_sync_then_runs_its_own() {
        let fx = Fx::start("conc-finish-waits", 49, &[("data/account", b"v1")]);
        fs::write(fx.runtime.join("data/account"), b"v2 from the running sync").unwrap();
        let mut park = test_hooks::park_at(&fx.vault_dir, "copy");
        let syncing = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.sync())
        };
        assert!(park.wait_entered(WAIT));
        let closed = test_hooks::notify_at(&fx.vault_dir, "closed");
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finishing = {
            let (handle, finished) = (fx.handle.clone(), finished.clone());
            thread::spawn(move || {
                let r = handle.finish();
                finished.store(true, std::sync::atomic::Ordering::SeqCst);
                r
            })
        };
        assert!(closed.wait(WAIT), "shutdown never started");
        thread::sleep(Duration::from_millis(50));
        assert!(!finished.load(std::sync::atomic::Ordering::SeqCst), "shutdown ran over a sync that was mid-pass");
        park.release();
        syncing.join().unwrap().unwrap();
        finishing.join().unwrap().unwrap();
        assert!(!fx.runtime.exists());
        let restored = fx.restored_elsewhere("conc-finish-waits-restored");
        assert_eq!(fs::read(restored.path().join("data/account")).unwrap(), b"v2 from the running sync");
    }

    /// Timing probe, not a check: `cargo test --offline vault::session::tests::sync_cost -- --ignored --nocapture`.
    /// Builds a ~50 MB WAL-mode database, then times a pass with nothing
    /// changed and a pass after one row changed. A debug build, so the
    /// absolute numbers are pessimistic; the ratio is what matters.
    #[test]
    #[ignore]
    fn sync_cost_of_a_50_mb_database() {
        let fx = Fx::start("cost", 50, &[]);
        fs::create_dir_all(fx.runtime.join("data")).unwrap();
        let db = rusqlite::Connection::open(fx.runtime.join("data/account.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB);").unwrap();
        db.execute_batch("BEGIN").unwrap();
        for i in 0..12_800u32 {
            let payload: Vec<u8> = (0..4096u32).map(|j| (i.wrapping_mul(2_654_435_761).wrapping_add(j.wrapping_mul(40503)) >> 7) as u8).collect();
            db.execute("INSERT INTO blobs (b) VALUES (?1)", [payload]).unwrap();
        }
        db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        let size = fs::metadata(fx.runtime.join("data/account.db")).unwrap().len();

        let time = |label: &str, fx: &Fx| {
            let started = Instant::now();
            let report = fx.handle.sync().unwrap();
            eprintln!("COST {label}: {:?} (wrote={}, changed={})", started.elapsed(), report.wrote, report.changed);
        };
        eprintln!("COST database size: {} MiB", size / (1024 * 1024));
        time("first pass (everything is new)", &fx);
        time("no change, 1st repeat", &fx);
        time("no change, 2nd repeat", &fx);
        db.execute("UPDATE blobs SET b = zeroblob(4096) WHERE id = 1", []).unwrap();
        time("one row changed (lands in the WAL)", &fx);
        time("no change again", &fx);
    }

    /// A pass that fails after copying a database (here: the manifest commit)
    /// must not leave a fingerprint claiming the vault holds that state.
    #[test]
    fn a_failed_commit_does_not_mark_a_database_as_synced() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fx::start("conc-failed-commit", 51, &[]);
        let copies = test_hooks::record(&fx.vault_dir, "copy");
        let db_copies = || copies.lock().unwrap().iter().filter(|p| p.ends_with("account.db")).count();
        fs::create_dir_all(fx.runtime.join("data")).unwrap();
        let db = rusqlite::Connection::open(fx.runtime.join("data/account.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE msgs (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        db.execute("INSERT INTO msgs (body) VALUES ('a')", []).unwrap();
        fx.handle.sync().unwrap();
        assert_eq!(db_copies(), 1);

        db.execute("INSERT INTO msgs (body) VALUES ('b')", []).unwrap();
        let armed = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let vault_dir = fx.vault_dir.clone();
        test_hooks::set(&fx.vault_dir, move |point, _| {
            if point == "commit" && armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
                fs::set_permissions(&vault_dir, fs::Permissions::from_mode(0o500)).unwrap();
            }
        });
        let failed = fx.handle.sync();
        fs::set_permissions(&fx.vault_dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err(), "the commit was supposed to fail");
        assert_eq!(db_copies(), 2);

        let report = fx.handle.sync().unwrap();
        assert_eq!(db_copies(), 3, "the database whose commit failed was skipped as if synced");
        assert!(report.wrote);
        let restored = fx.restored_elsewhere("conc-failed-commit-restored");
        let check = rusqlite::Connection::open(restored.path().join("data/account.db")).unwrap();
        let n: i64 = check.query_row("SELECT count(*) FROM msgs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    /// A file whose stat moved but whose content didn't gets its manifest stat
    /// refreshed, so it isn't copied on every later pass.
    #[test]
    fn a_touched_but_identical_file_is_copied_once_more_then_skipped() {
        let fx = Fx::start("conc-touch-only", 52, &[]);
        let copies = test_hooks::record(&fx.vault_dir, "copy");
        write_file(&fx.runtime, "data/account", b"same bytes");
        fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 1);

        let file = fs::File::open(fx.runtime.join("data/account")).unwrap();
        file.set_modified(std::time::SystemTime::now() + Duration::from_secs(5)).unwrap();
        let report = fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 2);
        assert_eq!(report.changed, 0, "no new blob for identical content");
        fx.handle.sync().unwrap();
        fx.handle.sync().unwrap();
        assert_eq!(copies.lock().unwrap().len(), 2, "the refreshed stat should make later passes skip the file");
    }

    /// An error no sync can explain fails at once instead of waiting behind
    /// the sync in flight.
    #[test]
    fn an_unrecoverable_hydration_error_does_not_wait_for_a_sync() {
        let fx = Fx::start("conc-no-wait", 53, &[("data/account", b"v1"), ("attachments/m.bin", b"media bytes")]);
        // A directory where the file belongs: the final rename fails.
        fs::create_dir_all(fx.runtime.join("attachments/m.bin")).unwrap();
        fs::write(fx.runtime.join("data/account"), b"changed so the sync has work").unwrap();
        let mut park = test_hooks::park_at(&fx.vault_dir, "copy");
        let syncing = {
            let handle = fx.handle.clone();
            thread::spawn(move || handle.sync())
        };
        assert!(park.wait_entered(WAIT));
        let (tx, rx) = mpsc::channel();
        {
            let handle = fx.handle.clone();
            thread::spawn(move || tx.send(handle.ensure_media("attachments/m.bin")).unwrap());
        }
        let err = rx.recv_timeout(WAIT).expect("the error waited for the sync").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Internal);
        park.release();
        syncing.join().unwrap().unwrap();
    }
}
