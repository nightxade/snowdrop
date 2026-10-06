# Desktop app

Snowdrop's desktop app is the same React UI running inside a [Tauri
v2](https://v2.tauri.app/) shell (app identifier `local.snowdrop.desktop`,
window "Snowdrop", 1280×800, minimum 360×560). The Rust side owns the
signal-cli process. Snowdrop itself ships with **no signal-cli binary at
all** — the app stays around 10 MB, and nobody has to trust _us_ with a
redistributed copy of someone else's GPL program. Instead, the first time it
needs signal-cli and doesn't already have one, the app downloads the pinned
release straight from [AsamK/signal-cli's own GitHub
releases](https://github.com/AsamK/signal-cli/releases) over HTTPS,
checksum-verifies it, and installs it into its own data directory. Browser
mode (talking to a signal-cli daemon you run yourself — see
[SIGNAL_CLI.md](SIGNAL_CLI.md)) remains available and is what `npm run dev`
gives you.

A separate, **optional** build (`npm run tauri:build:bundled`) instead
bundles signal-cli inside the app package at build time, the old way — see
"The optional bundled build" below. It exists for anyone who'd rather ship a
single self-contained artefact and is willing to take on signal-cli's GPL-3.0
obligations (shipping its source) themselves; it is not what `tauri:build`
produces by default.

**Privacy note:** the first run that needs signal-cli contacts
`github.com` exactly once, to download it. Nothing else about your use of
Snowdrop is sent anywhere by this download (no telemetry, no analytics) —
it's the same HTTPS GET your browser would make visiting the release page
yourself. After that first download, Snowdrop runs entirely offline except
for your own signal-cli traffic to Signal's servers.

## Dev and build

```sh
npm run tauri:dev     # `tauri dev` (hot-reloads the UI at localhost:5173)
npm run tauri:build   # `tauri build` (produces an AppImage and a .deb; no bundled signal-cli)
```

Dev loads `http://localhost:5173` (`beforeDevCommand: npm run dev -- --port
5173 --strictPort`); a build runs `npm run build` into `dist/`
(`frontendDist`). Bundle targets are `appimage` and `deb`
(`src-tauri/tauri.conf.json`, `bundle.targets`). `tauri` itself (the Tauri
CLI, `@tauri-apps/cli`) is also exposed as `npm run tauri -- <args>` for
anything else (`tauri icon`, `tauri info`, …).

Neither command downloads signal-cli: that only happens inside the running
app (`signal_cli_install` below), on first launch or when Settings →
Connection asks it to. There's nothing a `cargo build` in `src-tauri/`
needs that isn't already in the repo.

`scratch/tauri-env.sh` (outside this repo, alongside it) is **optional**: it
just points `CARGO_HOME`, `CARGO_TARGET_DIR`, `XDG_CACHE_HOME` and the npm
cache at a workspace-local directory, so Rust/npm downloads and build
products stay inside `~/Downloads/aligns` instead of `~/.cargo` or
`~/.cache`. Plain `npm run tauri:dev` / `npm run tauri:build` work fine
without sourcing it.

## Media playback (GStreamer)

The AppImage bundles its own copy of WebKitGTK, which can't see GStreamer
plugins installed on the host system — even when they're present (e.g.
`gst-plugins-base`/`good`/`libav`), the sandboxed WebKitGTK looks in its own
bundled plugin path first and doesn't find `appsink` and friends, so playing
an audio/video attachment logged `GStreamer element appsink not found` at
launch and attachments didn't play.

Fix: `bundle.linux.appimage.bundleMediaFramework: true`
(`src-tauri/tauri.conf.json`) tells `tauri build` to bundle GStreamer's own
base/good/bad/ugly plugins and libav _inside_ the AppImage, next to the
bundled WebKitGTK, so playback works regardless of what's on the host. This
is why the AppImage is noticeably bigger — about **100 MB without it, ~168
MB with it** (0.1.0, x86_64) — the GStreamer plugin set and its codec
libraries dominate the difference. `tauri.bundled.conf.json` (the
`tauri:build:bundled` overlay) doesn't touch `bundle.linux`, so it inherits
the same setting.

The `.deb` doesn't bundle anything (it links the _system_ WebKitGTK and
GStreamer), so it instead declares the plugin packages as dependencies —
`gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`,
`gstreamer1.0-libav` — in `bundle.linux.deb.depends`, alongside the
WebKitGTK/GTK dependencies `cargo tauri build` already adds automatically.

Verified on 0.1.0: running the new AppImage for ~10 s (fresh
`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`) produces no
`appsink`/`appimagesink` warning on stderr, where the pre-fix build logged
it at launch.

## Downloading signal-cli (the default)

`src-tauri/signal-cli.json` is the **one pinned source of truth**, read by
both the Rust downloader and (for the optional bundled build only)
`scripts/fetch-signal-cli.mjs`:

```json
{
  "version": "0.14.8",
  "repo": "https://github.com/AsamK/signal-cli",
  "assets": {
    "x86_64-unknown-linux-gnu": {
      "name": "signal-cli-0.14.8-Linux-native.tar.gz",
      "sha256": "36569af20c709e0c5e6e677b74f50f147b21f3740620b8a7affde70f6027f82a"
    }
  },
  "licenseSha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
  "downloadSizeBytes": 114000000
}
```

**To bump the version:** update `version`, the asset `name` and its `sha256`
together (the GitHub release page gives you the asset's checksum), then
delete any previous install under `<app data dir>/signal-cli/` and relaunch
(or, for the bundled build, run `node scripts/fetch-signal-cli.mjs --force`).
Both sides refuse to install anything whose hash doesn't match.

### How it works (`src-tauri/src/signal_cli_install.rs`)

1. The UI calls `signal_cli_install_status` to check whether the pinned
   version is already at `<app_data_dir>/signal-cli/<version>/signal-cli`.
2. If not, onboarding's first-run screen
   (`ui/features/onboarding/DownloadSignalCli.tsx`) names the version, size
   (≈114 MB) and source, and a "Download and continue" button calls
   `signal_cli_install`.
3. The Rust side streams the asset over HTTPS with `reqwest` (`rustls-tls` —
   no OpenSSL anywhere in this app) into a `.part` file under
   `<app_data_dir>/signal-cli/.install-tmp/`, emitting
   `signal-cli-install-progress` events (`{ received, total }`) as bytes
   arrive. A partial download can be resumed with an HTTP `Range` request on
   a later attempt, and `signal_cli_install_cancel` stops it mid-flight.
4. Once complete, its SHA-256 is checked against the pinned value — a
   mismatch deletes the file and fails the install; nothing unverified is
   ever extracted.
5. The verified `.tar.gz` is extracted with `flate2` + `tar`, rejecting any
   entry with an absolute path or a `..` component, and any entry that isn't
   a plain file or directory — symlinks, hard links, devices and FIFOs are
   all rejected too (path-traversal protection for a hostile or corrupted
   archive).
6. The `signal-cli` binary is marked executable and the whole result is
   built in a staged sibling directory, then **atomically** `rename`d into
   `<app_data_dir>/signal-cli/<version>/` — that directory is either absent
   or complete, never half-written, even if Snowdrop crashes or is killed
   mid-install.

A verified run installs:

- `<app_data_dir>/signal-cli/<version>/signal-cli` — on Linux, under
  `~/.local/share/local.snowdrop.desktop/signal-cli/0.14.8/signal-cli`
  (≈371 MB uncompressed; the download itself is ≈114 MB).

Only `linux`/`x64` has a pinned native (GraalVM, no JRE) asset today — see
"Other platforms".

### Resolution order

At connect time (`src-tauri/src/config.rs`, `resolve_binary`), signal-cli is
located in this order:

1. **Configured** — an absolute path from Settings → Connection
   (`DesktopConnection.binaryPath`). It must point to a file literally named
   `signal-cli` (or `.exe`/`.bat`), including through a symlink, and be
   executable; anything else is rejected before it's ever spawned.
2. **Downloaded** — the pinned version Snowdrop downloaded into
   `<app_data_dir>/signal-cli/<version>/` (above), if present.
3. **Bundled** — a sidecar Tauri installed next to the app's own executable,
   only in a build made with `npm run tauri:build:bundled` (the
   `bundled-sidecar` Cargo feature; see below). The default build has no
   such sidecar at all — this step never matches.
4. **PATH** — the first `signal-cli`/`signal-cli.exe`/`signal-cli.bat` found
   on `PATH`.

If none resolve, the UI shows a screen in onboarding: the first-run download
screen (`DownloadSignalCli.tsx`) when nothing is configured and nothing was
found at all, or `MissingSignalCli.tsx` (asks for a path) when a _configured_
path turned out bad. Settings → Connection can also just **locate** a binary
(`signal_cli_locate` → `ResolvedBinary { path, source }`) without connecting,
to show which one would be used, and has its own "Installed signal-cli" row
with a "Re-download" action.

## The optional bundled build

```sh
npm run tauri:build:bundled   # fetch the sidecar, then `tauri build` with it bundled in
```

This runs `scripts/fetch-signal-cli.mjs` (downloads and checksum-verifies the
same pinned release into `src-tauri/binaries/`), then `tauri build --config
tauri.bundled.conf.json --features bundled-sidecar`. The config overlay adds
`bundle.externalBin` (the sidecar) and `bundle.resources` (the licence files)
on top of the default `tauri.conf.json`; the Cargo feature compiles in
`config::bundled_sidecar()`'s real implementation (the default build's
version always returns `None`). `src-tauri/.gitignore` excludes
`binaries/` and `licenses/signal-cli/`; every bundled build re-fetches them.

**This build carries GPL-3.0 obligations Snowdrop itself doesn't otherwise
have**: because it redistributes signal-cli's binary inside the app package,
whoever ships it needs to make the corresponding source available alongside
it (see "GPL compliance" below) — `fetch-signal-cli.mjs` writes
`src-tauri/licenses/signal-cli/{COPYING,SOURCE.txt}` for exactly this reason,
and they're bundled as Tauri resources and listed on the About page only in
this build.

### Fixed arguments

Snowdrop decides every argument; nothing from the UI reaches the command line
except an account that already passed validation (`config::spawn_args`):

```
--config <data-dir> [-a <account>] jsonRpc --receive-mode=manual
```

`-a <account>` is added only for an explicit desktop account setting
(`connection.desktop.account`, E.164 phone number or ACI) — separate from
`connection.account`, which belongs to browser mode and is auto-remembered.
Leaving it unset runs signal-cli in multi-account mode.
`--receive-mode=manual` means signal-cli won't pull anything from Signal's
servers until the UI's first `subscribeReceive`, so nothing arrives before
anyone is listening.

### Data directory

Signal-cli's `--config` directory defaults to
`<Tauri app_data_dir>/signal-cli` (on Linux, under
`~/.local/share/local.snowdrop.desktop/`), kept apart from any signal-cli you
run yourself from a terminal. Override it with the `SNOWDROP_SIGNAL_CLI_DATA`
environment variable (useful for tests or running more than one profile).

## Transport layer

`core/backend/signal-cli/transport.ts` defines `SignalCliTransport` — the
seam between the signal-cli JSON-RPC client/normaliser (transport-agnostic)
and however bytes actually move:

- **Browser:** `httpTransport.ts`'s `HttpTransport` — `POST /api/v1/rpc` and
  `GET /api/v1/events` (Server-Sent Events, resumable with `Last-Event-ID`)
  through the dev/preview proxy.
- **Desktop:** `src/platform/tauri/TauriTransport.ts`'s `TauriTransport` —
  requests become Tauri command invocations (`signal_cli_connect`,
  `signal_cli_request`, `signal_cli_subscribe`, `signal_cli_ack`); incoming
  messages and stream state arrive as the Tauri events `signal-cli://event`
  and `signal-cli://state`, emitted by `src-tauri/src/lib.rs`.

`app/backends.ts` picks `TauriTransport` when `platform/detect.ts`'s
`isTauri()` is true, loaded through a dynamic `import('@/platform/tauri')` —
`core/` stays Tauri-free and the browser bundle never pulls in
`@tauri-apps/*`. That boundary is enforced by lint, not just convention: see
[ARCHITECTURE.md](ARCHITECTURE.md#the-transport-layer-and-srcplatform).

## Cursor / held-event semantics

An HTTP daemon numbers its SSE events and can replay by id; a `jsonRpc` child
on stdin/stdout has nothing like that, and signal-cli acknowledges a message
to Signal's own servers the moment it receives it — not when Snowdrop has
stored it. So in spawn mode the Rust side (`src-tauri/src/events.rs`,
`EventLog`) holds every event it forwards, numbered `"<run>:<seq>"` per
process run, until the UI acknowledges it:

- `SyncService` acknowledges a cursor only after the event's repository write
  completes (`signal_cli_ack`, the same checkpoint → acknowledge pattern the
  HTTP transport uses) — see ["Checkpoints and
  acknowledgements"](ARCHITECTURE.md#checkpoints-and-acknowledgements).
- A webview reload resubscribes with its last-acknowledged cursor; events
  held after it are replayed, so nothing is lost.
- A cursor from a previous app run matches nothing and is ignored — the
  fresh subscription instead gets everything still held for that account.
- Held events are capped at 5000; past that the oldest are dropped.
- An app crash between forwarding an event and storing it loses that event —
  a known limit, not a bug to chase (there's no daemon-side buffer to fall
  back on in spawn mode).

The persisted resume key is `snowdrop.signal-cli.cursor.<resumeScope>.<self>`
— `desktop` for a spawned signal-cli, `desktop-external` for an external
daemon reached from the desktop app, versus the browser transport's own
scope. Cursors from one scope are meaningless to another and are treated as
unknown (replay everything currently held/available).

## Security model

- **Encrypted local storage.** [ENCRYPTION.md](ENCRYPTION.md) covers the full
  model: the key hierarchy (OS keyring, recovery key, passphrase), the
  signal-cli vault, web cache encryption, and Settings → Privacy & security
  (create/replace/remove a recovery key, add/change/remove a passphrase,
  re-enrol a keyring, erase all local data). `app_restart` (`AppHandle::restart`)
  is the one command there beyond the `storage_*` ones: erasing needs a fresh
  process, since the vault bridge and `snowdrop.lock` are one-shot per
  process.
- **Capabilities.** `src-tauri/capabilities/main.json` grants the main
  window exactly: `core:event:allow-listen`/`allow-unlisten`, three
  notification permissions, and the app's own 12 commands
  (`signal_cli_connect`, `signal_cli_request`, `signal_cli_subscribe`,
  `signal_cli_ack`, `signal_cli_probe`, `signal_cli_locate`,
  `signal_cli_pinned_release`, `signal_cli_install_status`,
  `signal_cli_install`, `signal_cli_install_cancel`, `desktop_info`,
  `open_external`). `build.rs` declares the app's command manifest, so no
  other command is callable at all, capability or not.
- **CSP.** `tauri.conf.json`'s `app.security.csp` is Snowdrop's normal
  production policy (`default-src 'self'`, no remote fetches) plus Tauri's
  own IPC origins (`connect-src ... ipc: http://ipc.localhost`); `devCsp` is
  `null` and `freezePrototype` is on. `devserver/csp.ts` exports the same
  policy as `TAURI_CSP` and a test keeps the two in sync, but a Tauri build
  injects no `<meta>` CSP tag — Tauri applies the one from `tauri.conf.json`
  itself.
- **Path validation.** A configured signal-cli path must be absolute, named
  `signal-cli` (or `.exe`/`.bat`) — including whatever a symlink resolves
  to — and executable (`config::validate_binary_path`). Accounts must be
  E.164 or a UUID-shaped ACI (`validate_account`). Nothing else from the UI
  reaches a command line.
- **Download integrity.** The signal-cli download is HTTPS over `rustls`
  (no OpenSSL anywhere in this app), checked against a pinned SHA-256 before
  extraction, and the `.tar.gz` extractor rejects any entry with an absolute
  path or a `..` component, as well as symlink, hard-link, device and FIFO
  entries (`signal_cli_install::extract_tar_gz`) — a corrupted or tampered
  archive can't write outside the install directory.
- **External daemon, loopback only.** `validate_daemon_url` accepts only
  `http://` (no TLS, matching signal-cli's own daemon) on `localhost`,
  `127.0.0.1`, `::1`, or another loopback address, with no embedded
  credentials — the same restriction browser mode documents in
  [SIGNAL_CLI.md](SIGNAL_CLI.md#privacy).
- **No shell/opener exposed to JS.** External links go through the
  `open_external` command, which only accepts `http://`, `https://` and
  `mailto:` (`commands::is_external_url`); the `@tauri-apps/plugin-opener`
  _npm_ package isn't a dependency at all (only the Rust crate, called from
  this one command), so the webview has no generic "open anything" API.
- **Devtools off in release.** `src-tauri/Cargo.toml` depends on
  `tauri = { version = "2", features = [] }` — the `devtools` feature isn't
  enabled, so devtools are compiled out of release builds.
- **One instance.** `tauri-plugin-single-instance` focuses the existing
  window instead of starting a second signal-cli process. Window size and
  position are restored by `tauri-plugin-window-state`.

## Logs and troubleshooting

- Everything Snowdrop logs — its own Rust code (`log::warn!`/`info!`/…),
  the frontend (`frontend_log`, target `ui:<scope>`) and signal-cli's
  stderr (target `signal-cli`) — goes through one app-wide logger
  (`src-tauri/src/applog.rs`) to a single file, `<app log dir>/snowdrop.log`
  (`src-tauri/src/logfile.rs`), capped at 1 MB with one rotation
  (`snowdrop.log.1`). The exact path is shown on the About page and from
  `desktop_info`, and a "Open log folder" action (`log_open_folder`) opens
  it directly.
  - **Redaction guarantee.** Every message is scrubbed
    (`src-tauri/src/redact.rs`) before it's written anywhere, stderr
    included: phone numbers, UUIDs/ACIs, `sgnl://` link URIs and long
    base64 runs (group ids, keys) are replaced with placeholders, control
    characters and embedded newlines are stripped, and each line is capped
    at 2000 characters. Message bodies, contact names and raw JSON-RPC
    payloads are never logged in the first place (lengths and types
    instead) — redaction is a second line of defence, not the only one.
  - **Level.** Default is Warn. `SNOWDROP_LOG=error|warn|info|debug|trace`
    overrides that at startup; a runtime "verbose logging" toggle
    (`log_set_verbose`) raises the floor to Debug without restarting
    (noisy dependencies — tao, wry, zbus, hyper, reqwest, … — stay at Warn
    either way). `log_recent` returns the tail of the current log (plus
    `.1` if needed) for in-app display, capped at 256 KiB.
- A harmless GraalVM "Fatal error: InterruptedException" dump (exit code 99)
  lands in that log whenever Snowdrop stops signal-cli (it closes stdin,
  waits 5 s, then kills) — see "Known issues" in the handoff notes; it does
  not indicate a real crash. A JVM native crash dump's register/stack-frame
  lines (`  |0x...`) are collapsed into one summary line rather than logged
  one by one.
- Settings → Connection can **locate** or **probe** a configuration
  (`signal_cli_locate` / `signal_cli_probe`) without connecting, to check
  which binary resolves, its version, and (if a matching child is already
  running) its account count. Its "Installed signal-cli" row
  (`DesktopConnectionRows.tsx`) shows the downloaded version and path, with
  a "Re-download" action (`signal_cli_install_status` / `signal_cli_install`).
- `SNOWDROP_SIGNAL_CLI_DATA` overrides signal-cli's own `--config` data
  directory (its linked account and keys), which is useful for isolating a
  test run. It does not move the download: that always lives under the real
  `<app_data_dir>/signal-cli/<version>/`, which `SNOWDROP_SIGNAL_CLI_DATA`
  doesn't affect.
- A failed or cancelled download leaves no partial install directory (only,
  possibly, a resumable `.part` file under `.install-tmp/` — safe to delete
  by hand if you want a completely fresh attempt).

## Other platforms

The pinned, self-contained (GraalVM, no JRE) signal-cli build only exists for
Linux x86_64. Both the Rust downloader and `fetch-signal-cli.mjs` refuse to
install anything on any other host (no pinned asset to fetch). A desktop
build for macOS, Windows, or other Linux architectures therefore has
**nothing to download**: install the regular Java-based signal-cli build
yourself (a JRE, 25 or newer for current releases — see
[SIGNAL_CLI.md](SIGNAL_CLI.md#1-install-signal-cli)) and either put it on
`PATH` or point Settings → Connection at its absolute path.
External-daemon mode (`signal-cli daemon --http ...`, loopback only) works
the same way on any platform.

## GPL compliance

signal-cli is GPL-3.0, written by AsamK and contributors. In the **default**
build, Snowdrop never redistributes it at all: the app downloads it directly
from AsamK/signal-cli's own GitHub release, onto the user's own computer,
the same as if they'd done it themselves with a browser — so Snowdrop itself
takes on no GPL distribution obligations for it. It still runs unmodified as
a separate program Snowdrop starts and talks to over stdin/stdout, never
linked into Snowdrop, and the About page says so and links to its release
page.

The **optional bundled build** (`npm run tauri:build:bundled`) is different:
it _does_ redistribute signal-cli's binary, inside the app package, so
whoever ships that build takes on the obligation to make the corresponding
source available alongside it. `fetch-signal-cli.mjs` downloads and
checksum-verifies the exact tag's `LICENSE` file into
`src-tauri/licenses/signal-cli/COPYING`, and writes `SOURCE.txt` recording
the release tag, the exact source tree and archive URLs, and the installed
asset's checksum. Both files are declared as Tauri `resources` in
`tauri.bundled.conf.json` (so they ship inside that app package) and are:

- appended to `dist/THIRD_PARTY_NOTICES.txt` on a bundled build
  (`devserver/notices.ts`, `SNOWDROP_BUNDLED=1`), which refuses to build
  without them;
- shown on the About page, along with the GPL text and the exact-source
  link, instead of the default build's release-page link
  (`ui/features/settings/about/AboutPage.tsx`).

signal-cli's data/log paths are shown on the About page in both builds.

## Rust crate notices

`src-tauri/THIRD_PARTY_NOTICES-rust.txt` is the attribution file for every
Rust crate actually compiled into the desktop binary (`src-tauri/Cargo.lock`
minus build- and dev-only dependencies) — licence texts, deduplicated by
exact text, each followed by the crate(s) that use it. It's generated with
[`cargo-about`](https://github.com/EmbarkStudios/cargo-about), not checked
in, and regenerated with:

```sh
cargo install cargo-about --locked --features cli   # once
npm run notices:rust                                 # scripts/gen-rust-notices.mjs
```

`src-tauri/about.toml` is the config: the accepted licence list, which
build/dev dependencies to ignore, and a `[ring]` clarification. ring ships
three separate licence files (`LICENSE`, `LICENSE-BoringSSL`,
`LICENSE-other-bits` — its own `LICENSE` explains why), which cargo-about's
default file-system scan would otherwise either miss or, worse, match
against fragments of unrelated vendored source files; the clarification
pins the three real files by checksum instead. `src-tauri/about.hbs` is the
output template.

At build time, `devserver/notices.ts`'s `rustCrateNotices()` Vite plugin
copies the generated file into `dist/THIRD_PARTY_NOTICES-rust.txt`, next to
the web notices (`dist/THIRD_PARTY_NOTICES.txt`) — same mechanism, so both
are just static files the webview (or a browser) can fetch. A build without
having run `npm run notices:rust` first still succeeds, with a Vite warning;
the About page's link to it only renders for the desktop build (checked for
in CI before a release, not enforced by the web build).

## Future: a native backend

The backend registry (`app/backends.ts`, see
[ARCHITECTURE.md](ARCHITECTURE.md#how-to-add-a-backend-adapter)) could in
principle host a native Rust backend built on
[`presage`](https://github.com/whisperfish/presage) instead of spawning
signal-cli, removing the sidecar and its GPL process boundary entirely.
`presage` is **AGPL-3.0**, though: compiling it into Snowdrop's desktop
binary would place that binary's own source under AGPL-3.0 obligations,
unlike the current arm's-length signal-cli subprocess. That's a licensing
decision for whoever picks this up, not just an engineering one, and nothing
here should be read as having made it.
