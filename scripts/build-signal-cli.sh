#!/usr/bin/env bash
# Builds the history-patched signal-cli (patches/signal-cli/*.patch) into a
# self-contained, jlinked runtime at patches/signal-cli/dist/signal-cli/, and
# optionally installs it into Snowdrop's app data directory so the desktop
# app picks it up automatically (src-tauri/src/config.rs, `BinarySource::
# Patched`). This is a *developer* tool, run by hand — it never runs as part
# of `npm run tauri:build` or any other default build, and it never touches
# the GPL-3.0 download/bundling paths in signal_cli_install.rs or
# fetch-signal-cli.mjs.
#
# Usage:
#   scripts/build-signal-cli.sh            # clone, patch, build, jlink, smoke-test
#   scripts/build-signal-cli.sh --test      # same, but runs the README's history
#                                            # test suite before `installDist`
#   scripts/build-signal-cli.sh --install   # build (unless dist/ already has a
#                                            # working build) and then install it
#
# Env vars (all optional, with defaults below):
#   SNOWDROP_JDK        JDK 25 home. `java -version` under it must report 25.
#   SIGNAL_CLI_SRC      git URL or local path to clone signal-cli from.
#   SNOWDROP_APP_DATA   overrides the app data dir --install copies into
#                       (defaults to the real Snowdrop app data dir — pass
#                       this when testing --install against a scratch dir).
#
# Everything this script writes lives under patches/signal-cli/.work/ (the
# clone + build tree) and patches/signal-cli/dist/ (the finished runtime) —
# both gitignored. Re-running is safe: the clone is reused and fast-forwarded,
# and the dist directory is only ever replaced atomically (built into a temp
# sibling, then swapped in with `rm -rf` + `mv`), so a failed or interrupted
# build never leaves a half-written dist/signal-cli/ behind.
set -euo pipefail

# ─── Fixed facts about the patch set (patches/signal-cli/README.md) ───────
readonly UPSTREAM_COMMIT="22b028bbb9cee8f6aa22af71c6b3e9d09028a16a"
readonly UPSTREAM_TAG="v0.14.8"
# ────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHES_DIR="$ROOT_DIR/patches/signal-cli"
WORK_DIR="$PATCHES_DIR/.work"
SRC_DIR="$WORK_DIR/signal-cli-src"
DIST_DIR="$PATCHES_DIR/dist"

SIGNAL_CLI_SRC="${SIGNAL_CLI_SRC:-https://github.com/AsamK/signal-cli.git}"

# The runtime's modules. A fixed list rather than `jdeps` output: jdeps
# can't resolve this jar set (split packages across signal-cli's modular
# dependencies), and much of what's needed is only reached through
# reflection, JNI or ServiceLoader anyway (TLS providers, sqlite-jdbc,
# libsignal's JNI bridge, locale data, DNS). Verified by the smoke tests
# below, which reach Signal's servers.
readonly RUNTIME_MODULES="java.base,java.desktop,java.logging,java.management,java.naming,java.net.http,java.prefs,java.scripting,java.security.jgss,java.security.sasl,java.sql,java.xml,jdk.charsets,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.localedata,jdk.management,jdk.naming.dns,jdk.net,jdk.security.auth,jdk.unsupported,jdk.zipfs"

DO_TEST=0
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --test) DO_TEST=1 ;;
    --install) DO_INSTALL=1 ;;
    *)
      echo "build-signal-cli.sh: unknown flag '$arg' (expected --test and/or --install)" >&2
      exit 1
      ;;
  esac
done

log() { echo "[build-signal-cli] $*"; }
die() { echo "[build-signal-cli] ERROR: $*" >&2; exit 1; }

# ─── JDK 25 ────────────────────────────────────────────────────────────────
resolve_jdk() {
  [ -n "${SNOWDROP_JDK:-}" ] \
    || die "set SNOWDROP_JDK to a JDK 25 home (system java is usually too old for this build)."
  echo "$SNOWDROP_JDK"
}

check_jdk25() {
  local jdk="$1"
  [ -x "$jdk/bin/java" ] || die "SNOWDROP_JDK ($jdk) has no executable bin/java."
  local version_line
  version_line="$("$jdk/bin/java" -version 2>&1 | head -1)"
  case "$version_line" in
    *'"25'*) ;;
    *) die "SNOWDROP_JDK ($jdk) isn't JDK 25 (java -version said: $version_line). System java is usually too old." ;;
  esac
  log "Using JDK: $version_line ($jdk)"
}

SNOWDROP_JDK="$(resolve_jdk)"
check_jdk25 "$SNOWDROP_JDK"
export JAVA_HOME="$SNOWDROP_JDK"
export PATH="$SNOWDROP_JDK/bin:$PATH"

# ─── Build (skipped entirely for a plain --install if dist/ already works) ─
NEED_BUILD=1
if [ "$DO_INSTALL" -eq 1 ] && [ "$DO_TEST" -eq 0 ] && [ -x "$DIST_DIR/signal-cli/bin/signal-cli" ]; then
  log "dist/signal-cli already exists; skipping the build (remove $DIST_DIR to force one, or pass no --install to always rebuild)."
  NEED_BUILD=0
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  mkdir -p "$WORK_DIR"

  # ── Clone/fetch the pinned upstream commit, detached ──────────────────
  if [ -d "$SRC_DIR/.git" ]; then
    log "Fetching into existing clone at $SRC_DIR"
    git -C "$SRC_DIR" fetch --tags --force origin
  else
    log "Cloning $SIGNAL_CLI_SRC into $SRC_DIR"
    rm -rf "$SRC_DIR"
    git clone "$SIGNAL_CLI_SRC" "$SRC_DIR"
  fi

  log "Checking out $UPSTREAM_TAG ($UPSTREAM_COMMIT), detached"
  git -C "$SRC_DIR" checkout --detach "$UPSTREAM_COMMIT" \
    || die "couldn't check out $UPSTREAM_COMMIT in $SRC_DIR — does the clone's history include it?"

  actual_commit="$(git -C "$SRC_DIR" rev-parse HEAD)"
  [ "$actual_commit" = "$UPSTREAM_COMMIT" ] \
    || die "checked out $actual_commit, expected the pinned $UPSTREAM_COMMIT"

  # Clean work tree: a previous failed patch/build never leaks into this run.
  git -C "$SRC_DIR" reset --hard "$UPSTREAM_COMMIT"
  git -C "$SRC_DIR" clean -fdx

  # ── Apply the patches, in filename order, failing loudly by name ──────
  shopt -s nullglob
  patches=("$PATCHES_DIR"/*.patch)
  shopt -u nullglob
  [ "${#patches[@]}" -gt 0 ] || die "no patches found in $PATCHES_DIR"
  for patch in "${patches[@]}"; do
    log "Applying $(basename "$patch")"
    git -C "$SRC_DIR" apply "$patch" \
      || die "failed to apply $(basename "$patch") — it may no longer apply cleanly to $UPSTREAM_COMMIT"
  done

  # ── Optional: the README's history test suite, before installDist ─────
  if [ "$DO_TEST" -eq 1 ]; then
    log "Running the history test suite"
    (cd "$SRC_DIR" && ./gradlew --no-daemon test --tests '*HistoryCommandTest' :libsignal-cli:test --tests '*History*Test') \
      || die "history tests failed"
  fi

  # ── Build ───────────────────────────────────────────────────────────
  log "Running ./gradlew --no-daemon installDist (this can take a while)"
  (cd "$SRC_DIR" && ./gradlew --no-daemon installDist) \
    || die "./gradlew installDist failed"

  INSTALL_DIST="$SRC_DIR/build/install/signal-cli"
  [ -d "$INSTALL_DIST/lib" ] || die "installDist didn't produce $INSTALL_DIST/lib"
  [ -x "$INSTALL_DIST/bin/signal-cli" ] || die "installDist didn't produce an executable $INSTALL_DIST/bin/signal-cli"

  all_modules="$RUNTIME_MODULES"
  log "jlink module list: $all_modules"

  # ── Assemble the dist layout atomically: build into a temp sibling,
  #    then swap it in with one rm + one rename. ──────────────────────────
  BUILD_TMP="$DIST_DIR.build.$$"
  rm -rf "$BUILD_TMP"
  mkdir -p "$BUILD_TMP/signal-cli/bin"

  cp -a "$INSTALL_DIST/lib" "$BUILD_TMP/signal-cli/lib"

  log "Running jlink"
  # JDKs that ship without jmods/ (JEP 493) link from their own run-time image.
  module_path=()
  [ -d "$SNOWDROP_JDK/jmods" ] && module_path=(--module-path "$SNOWDROP_JDK/jmods")
  "$SNOWDROP_JDK/bin/jlink" \
    "${module_path[@]}" \
    --add-modules "$all_modules" \
    --output "$BUILD_TMP/signal-cli/runtime" \
    --strip-debug --no-header-files --no-man-pages --compress zip-6

  # The original Gradle start script, kept under a different name: it still
  # honours JAVA_HOME (see its own header), which the launcher below sets to
  # the jlinked runtime next to it.
  cp "$INSTALL_DIST/bin/signal-cli" "$BUILD_TMP/signal-cli/bin/signal-cli.gradle"
  chmod +x "$BUILD_TMP/signal-cli/bin/signal-cli.gradle"

  cat > "$BUILD_TMP/signal-cli/bin/signal-cli" <<'LAUNCHER'
#!/usr/bin/env bash
# Resolves its own real location (so this still works through a symlink —
# e.g. Snowdrop's app data dir), points JAVA_HOME at the jlinked runtime
# that ships next to it, and hands off to the original Gradle start script.
set -euo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}")"
bin_dir="$(dirname "$self")"
root_dir="$(dirname "$bin_dir")"
export JAVA_HOME="$root_dir/runtime"
exec "$bin_dir/signal-cli.gradle" "$@"
LAUNCHER
  chmod +x "$BUILD_TMP/signal-cli/bin/signal-cli"

  {
    echo "Upstream commit: $UPSTREAM_COMMIT ($UPSTREAM_TAG)"
    echo "Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "JDK: $("$SNOWDROP_JDK/bin/java" -version 2>&1 | head -1)"
    echo "jlink modules: $all_modules"
    echo
    echo "Patches applied (sha256, in order):"
    for patch in "${patches[@]}"; do
      printf '  %s  %s\n' "$(sha256sum "$patch" | cut -d' ' -f1)" "$(basename "$patch")"
    done
  } > "$BUILD_TMP/signal-cli/PROVENANCE.txt"

  log "Swapping the new build into $DIST_DIR"
  rm -rf "$DIST_DIR"
  mv "$BUILD_TMP" "$DIST_DIR"

  # ── Smoke test: a clean environment, no inherited JAVA_HOME/PATH tricks ─
  log "Smoke-testing $DIST_DIR/signal-cli/bin/signal-cli --version"
  smoke_output="$(env -i PATH=/usr/bin:/bin HOME="$HOME" "$DIST_DIR/signal-cli/bin/signal-cli" --version)"
  case "$smoke_output" in
    *snowdrop-history*) log "Smoke test OK: $smoke_output" ;;
    *) die "smoke test failed — expected a version containing 'snowdrop-history', got: $smoke_output" ;;
  esac
fi

# ─── Optional install into Snowdrop's app data dir ─────────────────────────
if [ "$DO_INSTALL" -eq 1 ]; then
  [ -x "$DIST_DIR/signal-cli/bin/signal-cli" ] || die "nothing to install: $DIST_DIR/signal-cli/bin/signal-cli doesn't exist"

  app_data="${SNOWDROP_APP_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/local.snowdrop.desktop}"
  bin_dir="$app_data/bin"
  target_dir="$bin_dir/signal-cli-history"
  tmp_dir="$bin_dir/.tmp-install-$$"
  previous_dir="$bin_dir/signal-cli-history.previous"

  log "Installing into $target_dir"
  mkdir -p "$bin_dir"
  rm -rf "$tmp_dir"
  cp -a "$DIST_DIR/signal-cli" "$tmp_dir"

  # Keep exactly one rollback copy; everything else in $bin_dir (a downloaded
  # install, the download scratch dir) is left completely alone.
  rm -rf "$previous_dir"
  if [ -e "$target_dir" ]; then
    mv "$target_dir" "$previous_dir"
  fi
  mv "$tmp_dir" "$target_dir"

  log "Installed. Verifying the installed copy runs:"
  env -i PATH=/usr/bin:/bin HOME="$HOME" "$target_dir/bin/signal-cli" --version
fi

log "Done."
