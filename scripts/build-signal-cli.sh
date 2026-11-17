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
#   scripts/build-signal-cli.sh --test      # same, but runs the whole test suite
#                                            # (signal-service-java, lib, root) before
#                                            # `installDist`; the one place that command lives
#   scripts/build-signal-cli.sh --install   # build (unless dist/ was built from exactly the
#                                            # sources on disk now) and then install it
#   scripts/build-signal-cli.sh --native    # additionally compile a GraalVM native
#                                            # build (patches/signal-cli/dist-native/);
#                                            # needs SNOWDROP_GRAALVM, else prints a hint
#                                            # and leaves the Java build as the only one.
#                                            # With --install it is installed beside the
#                                            # Java build, which stays where it is.
#
# Env vars (all optional, with defaults below):
#   SNOWDROP_JDK          JDK 25 home. `java -version` under it must report 25.
#   SNOWDROP_GRAALVM      GraalVM JDK 25 home (with bin/native-image), for --native only.
#                         The native build takes ~6 minutes and ~5 GiB of RAM.
#   SIGNAL_CLI_SRC        git URL or local path to clone signal-cli from.
#   SIGNAL_SERVICE_JAVA_SRC  git URL or local path to clone signal-service-java from
#                            (patches/signal-service-java; default: upstream's GitHub repo).
#   SNOWDROP_APP_DATA     overrides the app data dir --install copies into
#                         (defaults to the real Snowdrop app data dir — pass
#                         this when testing --install against a scratch dir).
#   SNOWDROP_GRADLE_ARGS  extra arguments for every ./gradlew run (e.g. "--max-workers=2").
#
# Before building signal-cli itself, this script also clones, patches, tests and locally
# publishes patches/signal-service-java (the custom-emoji unknown-fields hook) under its own
# .work/ tree, then points signal-cli's build at that jar via SNOWDROP_SIGNAL_SERVICE_VERSION
# and SNOWDROP_SIGNAL_SERVICE_REPO (patches/signal-cli/lib/build.gradle.kts's dependency
# substitution — see that patch's README). See patches/signal-service-java/README.md.
#
# Everything this script writes lives under patches/signal-cli/.work/ (the
# clone + build tree) and patches/signal-cli/dist/ (the finished runtime) —
# both gitignored. Re-running is safe: the clone is reused and fast-forwarded,
# and a new dist is built into a temp sibling and only swapped in (`rm -rf` +
# `mv`) after it passed its smoke test, so a failed or interrupted build never
# leaves a half-written or broken dist/signal-cli/ behind. Temp directories are
# removed on exit, however the script ends.
set -euo pipefail

# ─── Fixed facts about the patch set (patches/signal-cli/README.md) ───────
readonly UPSTREAM_COMMIT="22b028bbb9cee8f6aa22af71c6b3e9d09028a16a"
readonly UPSTREAM_TAG="v0.14.8"
# ─── Fixed facts about patches/signal-service-java/README.md ─────────────
readonly SSJ_UPSTREAM_COMMIT="d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0"
readonly SSJ_UPSTREAM_TAG="v2.15.3_unofficial_153"
readonly SSJ_PATCHED_VERSION="2.15.3_unofficial_153-snowdrop.3"
# ────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/build-signal-cli.sh"
PATCHES_DIR="$ROOT_DIR/patches/signal-cli"
WORK_DIR="$PATCHES_DIR/.work"
SSJ_PATCHES_DIR="$ROOT_DIR/patches/signal-service-java"
SSJ_WORK_DIR="$SSJ_PATCHES_DIR/.work"
SSJ_SRC_DIR="$SSJ_WORK_DIR/libsignal-service-java-src"
SSJ_REPO_DIR="$SSJ_WORK_DIR/m2repo"
SRC_DIR="$WORK_DIR/signal-cli-src"
DIST_DIR="$PATCHES_DIR/dist"
NATIVE_DIST_DIR="$PATCHES_DIR/dist-native"

SIGNAL_CLI_SRC="${SIGNAL_CLI_SRC:-https://github.com/AsamK/signal-cli.git}"
SIGNAL_SERVICE_JAVA_SRC="${SIGNAL_SERVICE_JAVA_SRC:-https://github.com/Turasa/libsignal-service-java.git}"

# The runtime's modules. A fixed list rather than `jdeps` output: jdeps
# can't resolve this jar set (split packages across signal-cli's modular
# dependencies), and much of what's needed is only reached through
# reflection, JNI or ServiceLoader anyway (TLS providers, sqlite-jdbc,
# libsignal's JNI bridge, locale data, DNS). Verified by the smoke tests
# below, which reach Signal's servers.
readonly RUNTIME_MODULES="java.base,java.desktop,java.logging,java.management,java.naming,java.net.http,java.prefs,java.scripting,java.security.jgss,java.security.sasl,java.sql,java.xml,jdk.charsets,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.localedata,jdk.management,jdk.naming.dns,jdk.net,jdk.security.auth,jdk.unsupported,jdk.zipfs"

DO_TEST=0
DO_INSTALL=0
DO_NATIVE=0
for arg in "$@"; do
  case "$arg" in
    --native) DO_NATIVE=1 ;;
    --test) DO_TEST=1 ;;
    --install) DO_INSTALL=1 ;;
    *)
      echo "build-signal-cli.sh: unknown flag '$arg' (expected --test, --native and/or --install)" >&2
      exit 1
      ;;
  esac
done

log() { echo "[build-signal-cli] $*"; }
die() { echo "[build-signal-cli] ERROR: $*" >&2; exit 1; }

# Extra ./gradlew arguments from the environment, word-split on purpose.
read -r -a GRADLE_EXTRA <<< "${SNOWDROP_GRADLE_ARGS:-}"

# Temp directories this run creates; removed however the script ends (a failed build or smoke
# test must not leave ~50 MB jlink outputs behind).
BUILD_TMP="" NAT_TMP="" bin_dir=""
cleanup() {
  [ -z "$BUILD_TMP" ] || rm -rf "$BUILD_TMP"
  [ -z "$NAT_TMP" ] || rm -rf "$NAT_TMP"
  [ -z "$bin_dir" ] || rm -rf "$bin_dir"/.tmp-install-$$-*
}
trap cleanup EXIT

# ─── Patch lists (top level: --native and --install need them even when the Java build is skipped) ─
shopt -s nullglob
patches=("$PATCHES_DIR"/*.patch)
ssj_patches=("$SSJ_PATCHES_DIR"/*.patch)
shopt -u nullglob
SRC_CLASSES_DIR="$SRC_DIR/build/classes/java/main"
# Also an input of the build (it publishes the patched signal-service-java jar), though not a *.patch.
SSJ_INIT_SCRIPT="$SSJ_PATCHES_DIR/publish-local.init.gradle.kts"
# The version this series builds as: set in exactly one patch hunk (build.gradle.kts).
BUILD_VERSION="$(cat "${patches[@]}" | sed -n 's/^+    version = "\(.*snowdrop-history.*\)"$/\1/p' | tail -n 1)"
[ -n "$BUILD_VERSION" ] || { echo "[build-signal-cli] ERROR: no snowdrop-history version found in the patches." >&2; exit 1; }

# Writes a PROVENANCE.txt: what a dist was built from. $1 = output file, $2 = "jvm" or "native",
# $3 = (native only) an extra line to record. scripts/desktop-update.mjs (via
# scripts/lib/updateState.mjs) reads the shared fields to decide whether a rebuild or an install
# is needed.
write_provenance() {
  local out="$1" kind="$2" extra="${3:-}"
  {
    echo "Upstream commit: $UPSTREAM_COMMIT ($UPSTREAM_TAG)"
    echo "Build script sha256: $(sha256sum "$SCRIPT_PATH" | cut -d' ' -f1)"
    echo "signal-cli build version: $BUILD_VERSION"
    echo "Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "JDK: $("$SNOWDROP_JDK/bin/java" -version 2>&1 | head -1)"
    if [ "$kind" = "native" ]; then
      echo "Build kind: native image"
      echo "GraalVM: $("$SNOWDROP_GRAALVM/bin/java" -version 2>&1 | head -1)"
      [ -z "$extra" ] || echo "$extra"
    else
      echo "jlink modules: $RUNTIME_MODULES"
    fi
    echo
    echo "Patches applied (sha256, in order):"
    for patch in "${patches[@]}"; do
      printf '  %s  %s\n' "$(sha256sum "$patch" | cut -d' ' -f1)" "$(basename "$patch")"
    done
    echo
    echo "signal-service-java upstream commit: $SSJ_UPSTREAM_COMMIT ($SSJ_UPSTREAM_TAG)"
    echo "signal-service-java patched version: $SSJ_PATCHED_VERSION"
    echo "signal-service-java publish script sha256: $(sha256sum "$SSJ_INIT_SCRIPT" | cut -d' ' -f1)"
    echo "signal-service-java patches applied (sha256, in order):"
    for patch in "${ssj_patches[@]}"; do
      printf '  %s  %s\n' "$(sha256sum "$patch" | cut -d' ' -f1)" "$(basename "$patch")"
    done
    if [ "$kind" = "native" ]; then
      echo
      echo "Native build files (sha256):"
      for f in "$PATCHES_DIR"/native/*; do
        printf '  %s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(basename "$f")"
      done
    fi
  } > "$out"
}

# Whether the PROVENANCE.txt at $1 was written from exactly the sources on disk now.
provenance_is_current() {
  local f="$1" p n
  [ -f "$f" ] || return 1
  grep -qF "Build script sha256: $(sha256sum "$SCRIPT_PATH" | cut -d' ' -f1)" "$f" || return 1
  grep -qF "signal-service-java publish script sha256: $(sha256sum "$SSJ_INIT_SCRIPT" | cut -d' ' -f1)" "$f" || return 1
  for p in "${patches[@]}" "${ssj_patches[@]}"; do
    grep -qF "$(sha256sum "$p" | cut -d' ' -f1)  $(basename "$p")" "$f" || return 1
  done
  n="$(grep -cE '^  [0-9a-f]{64}  ' "$f" || true)"
  [ "$n" -eq $((${#patches[@]} + ${#ssj_patches[@]})) ]
}

# Smoke test of a launcher in a clean environment: the version string, then one JSON-RPC round
# trip (`version` over jsonRpc, in an empty config dir, so no account is involved) that must end
# with exit status 0 once stdin closes, the way Snowdrop stops signal-cli.
smoke_test() {
  local launcher="$1" label="$2" out reply tmp rc=0
  out="$(env -i PATH=/usr/bin:/bin HOME="$HOME" "$launcher" --version)"
  case "$out" in
    *"$BUILD_VERSION"*) ;;
    *) die "$label smoke test failed — expected version $BUILD_VERSION, got: $out" ;;
  esac
  tmp="$(mktemp -d)"
  reply="$({ printf '{"jsonrpc":"2.0","id":1,"method":"version"}\n'; sleep 3; } \
    | env -i PATH=/usr/bin:/bin HOME="$HOME" timeout 120 "$launcher" --config "$tmp" jsonRpc)" || rc=$?
  rm -rf "$tmp"
  [ "$rc" -eq 0 ] || die "$label smoke test failed — jsonRpc exited with status $rc after stdin closed"
  case "$reply" in
    *'"id":1'*"$BUILD_VERSION"*|*"$BUILD_VERSION"*'"id":1'*)
      log "$label smoke test OK: $out (JSON-RPC version answered, clean exit on stdin close)" ;;
    *) die "$label smoke test failed — unexpected JSON-RPC reply: $reply" ;;
  esac
}

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

# ─── Build (skipped for --install / --native if dist/ was built from these very sources) ─
# An existing dist/ is reused only if its PROVENANCE.txt matches the sources on disk now (patches,
# signal-service-java patches and publish script, this script). --native additionally needs the
# class files to still be in the work tree (the native step reads them). Without --install or
# --native the script always rebuilds, and --test always does.
NEED_BUILD=1
if [ "$DO_TEST" -eq 0 ] && [ -x "$DIST_DIR/signal-cli/bin/signal-cli" ] \
    && provenance_is_current "$DIST_DIR/signal-cli/PROVENANCE.txt"; then
  if [ "$DO_NATIVE" -eq 0 ] && [ "$DO_INSTALL" -eq 1 ]; then
    log "dist/signal-cli is current for these sources; skipping the build."
    NEED_BUILD=0
  elif [ "$DO_NATIVE" -eq 1 ] && [ -d "$SRC_CLASSES_DIR" ]; then
    log "dist/signal-cli is current for these sources; skipping the Java build."
    NEED_BUILD=0
  fi
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  mkdir -p "$WORK_DIR"

  # ── patches/signal-service-java: clone, patch, test and locally publish ─
  # the custom-emoji unknown-fields hook, before building signal-cli itself
  # (which depends on it — see patches/signal-cli/lib/build.gradle.kts). ──
  mkdir -p "$SSJ_WORK_DIR"

  if [ -d "$SSJ_SRC_DIR/.git" ]; then
    log "Fetching into existing clone at $SSJ_SRC_DIR"
    git -C "$SSJ_SRC_DIR" fetch --tags --force origin
  else
    log "Cloning $SIGNAL_SERVICE_JAVA_SRC into $SSJ_SRC_DIR"
    rm -rf "$SSJ_SRC_DIR"
    git clone "$SIGNAL_SERVICE_JAVA_SRC" "$SSJ_SRC_DIR"
  fi

  log "Checking out $SSJ_UPSTREAM_TAG ($SSJ_UPSTREAM_COMMIT), detached"
  git -C "$SSJ_SRC_DIR" checkout --detach "$SSJ_UPSTREAM_COMMIT" \
    || die "couldn't check out $SSJ_UPSTREAM_COMMIT in $SSJ_SRC_DIR — does the clone's history include it?"

  ssj_actual_commit="$(git -C "$SSJ_SRC_DIR" rev-parse HEAD)"
  [ "$ssj_actual_commit" = "$SSJ_UPSTREAM_COMMIT" ] \
    || die "checked out $ssj_actual_commit, expected the pinned $SSJ_UPSTREAM_COMMIT"

  git -C "$SSJ_SRC_DIR" reset --hard "$SSJ_UPSTREAM_COMMIT"
  git -C "$SSJ_SRC_DIR" clean -fdx

  shopt -s nullglob
  ssj_patches=("$SSJ_PATCHES_DIR"/*.patch)
  shopt -u nullglob
  [ "${#ssj_patches[@]}" -gt 0 ] || die "no patches found in $SSJ_PATCHES_DIR"
  for patch in "${ssj_patches[@]}"; do
    log "Applying $(basename "$patch") (signal-service-java)"
    git -C "$SSJ_SRC_DIR" apply "$patch" \
      || die "failed to apply $(basename "$patch") — it may no longer apply cleanly to $SSJ_UPSTREAM_COMMIT"
  done

  if [ "$DO_TEST" -eq 1 ]; then
    log "Running signal-service-java's unit tests"
    (cd "$SSJ_SRC_DIR" && ./gradlew --no-daemon "${GRADLE_EXTRA[@]}" :lib:libsignal-service:test) \
      || die "signal-service-java tests failed"
  fi

  log "Publishing the patched signal-service-java jar to $SSJ_REPO_DIR"
  rm -rf "$SSJ_REPO_DIR"
  SNOWDROP_SIGNAL_SERVICE_REPO="$SSJ_REPO_DIR" \
    bash -c 'cd "$1" && shift && ./gradlew --no-daemon "$@"' _ "$SSJ_SRC_DIR" "${GRADLE_EXTRA[@]}" \
      --init-script "$SSJ_PATCHES_DIR/publish-local.init.gradle.kts" \
      :lib:libsignal-service:publishAllPublicationsToSnowdropLocalRepository \
    || die "failed to publish the patched signal-service-java jar"

  [ -f "$SSJ_REPO_DIR/com/github/turasa/signal-service-java/$SSJ_PATCHED_VERSION/signal-service-java-$SSJ_PATCHED_VERSION.jar" ] \
    || die "publish succeeded but the expected jar is missing from $SSJ_REPO_DIR"

  # Picked up by signal-cli's lib/build.gradle.kts dependency substitution below.
  export SNOWDROP_SIGNAL_SERVICE_VERSION="$SSJ_PATCHED_VERSION"
  export SNOWDROP_SIGNAL_SERVICE_REPO="$SSJ_REPO_DIR"

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

  # ── Optional: the whole test suite (lib and root projects), unfiltered, before installDist ─
  if [ "$DO_TEST" -eq 1 ]; then
    log "Running the signal-cli test suite"
    (cd "$SRC_DIR" && ./gradlew --no-daemon "${GRADLE_EXTRA[@]}" :libsignal-cli:test :test) \
      || die "signal-cli tests failed"
  fi

  # ── Build ───────────────────────────────────────────────────────────
  log "Running ./gradlew --no-daemon installDist (this can take a while)"
  (cd "$SRC_DIR" && ./gradlew --no-daemon "${GRADLE_EXTRA[@]}" installDist) \
    || die "./gradlew installDist failed"

  INSTALL_DIST="$SRC_DIR/build/install/signal-cli"
  [ -d "$INSTALL_DIST/lib" ] || die "installDist didn't produce $INSTALL_DIST/lib"
  [ -x "$INSTALL_DIST/bin/signal-cli" ] || die "installDist didn't produce an executable $INSTALL_DIST/bin/signal-cli"

  # The dependency substitution in signal-cli's lib/build.gradle.kts should have swapped the
  # patched signal-service-java jar in for the stock one. Verify that actually happened.
  if ls "$INSTALL_DIST/lib"/signal-service-java-"$SSJ_PATCHED_VERSION".jar >/dev/null 2>&1; then
    log "Confirmed: $INSTALL_DIST/lib has the patched signal-service-java-$SSJ_PATCHED_VERSION.jar"
  else
    die "$INSTALL_DIST/lib is missing signal-service-java-$SSJ_PATCHED_VERSION.jar — the dependency substitution didn't take effect"
  fi
  if ls "$INSTALL_DIST/lib"/signal-service-java-*.jar 2>/dev/null | grep -qv "$SSJ_PATCHED_VERSION"; then
    die "$INSTALL_DIST/lib still has an unpatched signal-service-java jar alongside the patched one: $(ls "$INSTALL_DIST/lib"/signal-service-java-*.jar)"
  fi

  all_modules="$RUNTIME_MODULES"
  log "jlink module list: $all_modules"

  # ── Assemble the dist layout in a temp sibling, smoke-test it there, and only then
  #    swap it in (the exit trap removes the temp directory if anything fails first). ──
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

  write_provenance "$BUILD_TMP/signal-cli/PROVENANCE.txt" jvm

  # ── Smoke test the new build before it replaces anything: a clean environment, no
  #    inherited JAVA_HOME/PATH tricks. A failure leaves the previous dist/ untouched. ─
  smoke_test "$BUILD_TMP/signal-cli/bin/signal-cli" "Java build"

  log "Swapping the new build into $DIST_DIR"
  rm -rf "$DIST_DIR"
  mv "$BUILD_TMP" "$DIST_DIR"
  BUILD_TMP=""
  # A native build made from the previous Java build is stale now.
  rm -rf "$NATIVE_DIST_DIR"
fi

# ─── Optional GraalVM native build ──────────────────────────────────────────
# Compiles the already-built, already-patched classes (the Java build above, or its work tree) into
# one native executable: $NATIVE_DIST_DIR/signal-cli/signal-cli, with the AWT/ImageIO shim
# libraries the compiler emits beside it and libsignal's linux-x86_64 JNI library, which is left
# out of the image (see native/native-image.properties) and shipped stripped as libsignal_jni.so.
# It starts in tens of milliseconds and idles at well under half the Java build's memory.
# The native build runs in its own subshell (see below): `die` in here ends only that, and a
# failure of this experimental step must not stop the Java build from being installed.
build_native() {
  [ -x "$SNOWDROP_GRAALVM/bin/native-image" ] || die "SNOWDROP_GRAALVM ($SNOWDROP_GRAALVM) has no bin/native-image."
  graal_version="$("$SNOWDROP_GRAALVM/bin/java" -version 2>&1 | head -1)"
  case "$graal_version" in
    *'"25'*) ;;
    *) die "SNOWDROP_GRAALVM ($SNOWDROP_GRAALVM) isn't a JDK 25 (java -version said: $graal_version)." ;;
  esac
  [ "$(uname -m)" = "x86_64" ] || die "the native build supports Linux x86-64 only (libsignal's bundled JNI library)."
  [ -d "$SRC_CLASSES_DIR" ] || die "no compiled classes at $SRC_CLASSES_DIR to compile natively."
  export SNOWDROP_SIGNAL_SERVICE_VERSION="$SSJ_PATCHED_VERSION"
  export SNOWDROP_SIGNAL_SERVICE_REPO="$SSJ_REPO_DIR"
  log "Using GraalVM: $graal_version ($SNOWDROP_GRAALVM)"

  meta_dir="$SRC_DIR/src/main/resources/META-INF/native-image/org.asamk/signal-cli-snowdrop"
  rm -rf "$meta_dir"
  mkdir -p "$meta_dir"
  # Reflection metadata for the types the patches add or extend (Jackson result types, protobuf).
  python3 "$PATCHES_DIR/native/gen-native-metadata.py" "$SRC_DIR" "$meta_dir/reachability-metadata.json"
  cp "$PATCHES_DIR/native/awt-reachability-metadata.json" "$meta_dir/reachability-metadata-awt.json"
  cp "$PATCHES_DIR/native/native-image.properties" "$meta_dir/native-image.properties"

  log "nativeCompile with $SNOWDROP_GRAALVM (several minutes, ~5 GiB RAM)"
  (cd "$SRC_DIR" && GRAALVM_HOME="$SNOWDROP_GRAALVM" JAVA_HOME="$SNOWDROP_GRAALVM" PATH="$SNOWDROP_GRAALVM/bin:$PATH" ./gradlew --no-daemon "${GRADLE_EXTRA[@]}" nativeCompile) \
    || die "./gradlew nativeCompile failed"
  nat_out="$SRC_DIR/build/native/nativeCompile"
  [ -x "$nat_out/signal-cli" ] || die "nativeCompile didn't produce $nat_out/signal-cli"

  NAT_TMP="$NATIVE_DIST_DIR.build.$$"
  trap 'rm -rf "$NAT_TMP"' EXIT   # the script's own exit trap does not run in this subshell
  rm -rf "$NAT_TMP"
  mkdir -p "$NAT_TMP/signal-cli"
  cp -a "$nat_out"/. "$NAT_TMP/signal-cli/"
  libsignal_jar="$(ls "$DIST_DIR/signal-cli/lib"/libsignal-client-*.jar | head -1)"
  unzip -p "$libsignal_jar" libsignal_jni_amd64.so > "$NAT_TMP/signal-cli/libsignal_jni.so"
  strip --strip-unneeded "$NAT_TMP/signal-cli/libsignal_jni.so"
  chmod 755 "$NAT_TMP/signal-cli/libsignal_jni.so"
  write_provenance "$NAT_TMP/signal-cli/PROVENANCE.txt" native \
    "libsignal_jni.so sha256: $(sha256sum "$NAT_TMP/signal-cli/libsignal_jni.so" | cut -d' ' -f1)"

  # Smoke-test before the swap: a failure leaves dist-native/ as it was.
  smoke_test "$NAT_TMP/signal-cli/signal-cli" "Native build"

  log "Swapping the native build into $NATIVE_DIST_DIR"
  rm -rf "$NATIVE_DIST_DIR"
  mv "$NAT_TMP" "$NATIVE_DIST_DIR"
}

NATIVE_FAILED=0
NATIVE_PID=""
if [ "$DO_NATIVE" -eq 1 ]; then
  if [ -z "${SNOWDROP_GRAALVM:-}" ]; then
    log "hint: set SNOWDROP_GRAALVM to a GraalVM JDK 25 home to also build the faster native build; only the Java build was built."
  else
    build_native &
    NATIVE_PID=$!
    # Ctrl-C / TERM: stop the native job too (an async job ignores SIGINT), by its own PID.
    trap 'kill "$NATIVE_PID" 2>/dev/null || true; exit 130' INT TERM
    if ! wait "$NATIVE_PID"; then
      NATIVE_FAILED=1
      log "WARNING: the native build failed (or failed its smoke test and was discarded). The Java build is unaffected and is still installed if --install was given."
    fi
    trap - INT TERM
  fi
fi

# ─── Optional install into Snowdrop's app data dir ─────────────────────────
# Layout under <app data>/bin/: signal-cli-history/ (the Java build, bin/signal-cli: the path the
# desktop app has always looked for) and signal-cli-history-native/ (the native build, with
# signal-cli at its top level), each with one rollback copy next to it (*.previous). Installing one
# never replaces the other.
# install_tree <source dir, or empty> <name>: copies the source in atomically, keeping the old copy
# as <name>.previous. With no source it only retires the installed copy (the same rotation).
install_tree() {
  local src="$1" name="$2"
  local target="$bin_dir/$name" tmp="$bin_dir/.tmp-install-$$-$name" previous="$bin_dir/$name.previous"
  # The same build is already there: leave it, and the rollback copy next to it, as they are.
  if [ -n "$src" ] && [ -f "$src/PROVENANCE.txt" ] && cmp -s "$src/PROVENANCE.txt" "$target/PROVENANCE.txt"; then
    log "$name is already up to date."
    return 0
  fi
  if [ -n "$src" ]; then
    rm -rf "$tmp"
    cp -a "$src" "$tmp"
  fi
  # Keep exactly one rollback copy; everything else in $bin_dir (a downloaded
  # install, the download scratch dir) is left completely alone.
  rm -rf "$previous"
  if [ -e "$target" ]; then
    mv "$target" "$previous"
  fi
  if [ -n "$src" ]; then
    mv "$tmp" "$target"
  fi
}

if [ "$DO_INSTALL" -eq 1 ]; then
  [ -x "$DIST_DIR/signal-cli/bin/signal-cli" ] || die "nothing to install: $DIST_DIR/signal-cli/bin/signal-cli doesn't exist"

  app_data="${SNOWDROP_APP_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/local.snowdrop.desktop}"
  bin_dir="$app_data/bin"
  target_dir="$bin_dir/signal-cli-history"
  native_target_dir="$bin_dir/signal-cli-history-native"
  mkdir -p "$bin_dir"

  log "Installing into $target_dir"
  install_tree "$DIST_DIR/signal-cli" signal-cli-history

  if [ -x "$NATIVE_DIST_DIR/signal-cli/signal-cli" ]; then
    log "Installing the native build into $native_target_dir"
    install_tree "$NATIVE_DIST_DIR/signal-cli" signal-cli-history-native
  elif [ -e "$native_target_dir" ]; then
    # An installed native build that doesn't match the Java build just installed would make the
    # app's behaviour depend on which one runs; retire it (it stays as the rollback copy).
    log "No native build matches this Java build; retiring the installed native build."
    install_tree "" signal-cli-history-native
  fi

  log "Installed. Verifying the installed copies run:"
  env -i PATH=/usr/bin:/bin HOME="$HOME" "$target_dir/bin/signal-cli" --version
  if [ -x "$native_target_dir/signal-cli" ]; then
    env -i PATH=/usr/bin:/bin HOME="$HOME" "$native_target_dir/signal-cli" --version
  fi
fi

[ "$NATIVE_FAILED" -eq 0 ] || die "the native build failed (see above); the Java build itself succeeded."
log "Done."
