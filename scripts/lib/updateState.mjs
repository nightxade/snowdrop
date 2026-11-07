// Pure helpers for scripts/desktop-update.mjs: parsing PROVENANCE.txt,
// deciding whether the patched signal-cli or the AppImage need a rebuild,
// and small config-file/process-list parsing. No filesystem, git, or
// process access happens in here — the caller does the I/O and passes in
// plain strings/arrays, which is what makes these easy to unit-test (see
// updateState.test.mjs).

import { createHash } from 'node:crypto';

/** sha256 of a string or Buffer, as lowercase hex. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Parses a `PROVENANCE.txt` written by `scripts/build-signal-cli.sh`.
 * Tolerant of older files that predate a given field (they come back as
 * `null` / an empty array) so this keeps working against provenance written
 * before a field was added.
 */
export function parseProvenance(text) {
  const result = {
    upstreamCommit: null,
    buildScriptHash: null,
    builtAt: null,
    patches: [],
    ssjUpstreamCommit: null,
    ssjPatchedVersion: null,
    ssjPublishScriptHash: null,
    ssjPatches: [],
    nativeFiles: [],
  };

  let section = null; // 'patches' | 'ssjPatches' | 'nativeFiles' | null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      section = null;
      continue;
    }

    const patchLine = /^([0-9a-f]{64})\s+(\S+)$/.exec(line);
    if (section === 'patches' && patchLine) {
      result.patches.push({ hash: patchLine[1], name: patchLine[2] });
      continue;
    }
    if (section === 'ssjPatches' && patchLine) {
      result.ssjPatches.push({ hash: patchLine[1], name: patchLine[2] });
      continue;
    }
    if (section === 'nativeFiles' && patchLine) {
      result.nativeFiles.push({ hash: patchLine[1], name: patchLine[2] });
      continue;
    }

    let m;
    if ((m = /^Upstream commit:\s*(\S+)/.exec(line))) {
      result.upstreamCommit = m[1];
    } else if ((m = /^Build script sha256:\s*([0-9a-f]+)/.exec(line))) {
      result.buildScriptHash = m[1];
    } else if ((m = /^Built:\s*(.+)$/.exec(line))) {
      result.builtAt = m[1];
    } else if (line === 'Patches applied (sha256, in order):') {
      section = 'patches';
    } else if ((m = /^signal-service-java upstream commit:\s*(\S+)/.exec(line))) {
      result.ssjUpstreamCommit = m[1];
    } else if ((m = /^signal-service-java patched version:\s*(\S+)/.exec(line))) {
      result.ssjPatchedVersion = m[1];
    } else if ((m = /^signal-service-java publish script sha256:\s*([0-9a-f]+)/.exec(line))) {
      result.ssjPublishScriptHash = m[1];
    } else if (line === 'signal-service-java patches applied (sha256, in order):') {
      section = 'ssjPatches';
    } else if (line === 'Native build files (sha256):') {
      section = 'nativeFiles';
    }
  }
  return result;
}

function sameHashList(a, b) {
  if (a.length !== b.length) return false;
  const byName = (x, y) => x.name.localeCompare(y.name);
  const sortedA = [...a].sort(byName);
  const sortedB = [...b].sort(byName);
  return sortedA.every((item, i) => item.name === sortedB[i].name && item.hash === sortedB[i].hash);
}

/**
 * Compares a parsed PROVENANCE.txt against the sources on disk right now.
 * `current` is `{ signalCliPatches, ssjPatches, buildScriptHash,
 * ssjPublishScriptHash }`, each patch list `{name, hash}[]`
 * (`ssjPublishScriptHash`, the hash of patches/signal-service-java's
 * publish-local.init.gradle.kts, is only compared when given). Returns `{needsRebuild, reasons}`; `reasons`
 * is empty iff `needsRebuild` is false.
 */
export function diffSignalCliSources(provenance, current) {
  const reasons = [];
  if (!sameHashList(provenance.patches, current.signalCliPatches)) {
    reasons.push('patches/signal-cli/*.patch changed since the last build');
  }
  if (!sameHashList(provenance.ssjPatches, current.ssjPatches)) {
    reasons.push('patches/signal-service-java/*.patch changed since the last build');
  }
  if (provenance.buildScriptHash == null) {
    reasons.push('recorded provenance predates build-script hash tracking');
  } else if (provenance.buildScriptHash !== current.buildScriptHash) {
    reasons.push('scripts/build-signal-cli.sh changed since the last build');
  }
  if (current.ssjPublishScriptHash != null) {
    if (provenance.ssjPublishScriptHash == null) {
      reasons.push('recorded provenance predates publish-script hash tracking');
    } else if (provenance.ssjPublishScriptHash !== current.ssjPublishScriptHash) {
      reasons.push(
        'patches/signal-service-java/publish-local.init.gradle.kts changed since the last build',
      );
    }
  }
  return { needsRebuild: reasons.length > 0, reasons };
}

/**
 * Whether the GraalVM native build (patches/signal-cli/dist-native) needs building. It is built
 * from the Java build's classes, so it is stale whenever that is rebuilt, and it uses the same
 * PROVENANCE.txt fields as the Java build. Without a GraalVM there is nothing to build: the
 * result says so (`skipped`) so the caller can print its one-line hint, and the Java build stays
 * the only one.
 *
 * `nativeProvenanceText` is dist-native's PROVENANCE.txt, or null if there isn't one; `current`
 * is what `diffSignalCliSources` takes plus `nativeFiles` (`{name, hash}[]` of
 * patches/signal-cli/native/*, which only the native build depends on).
 */
export function planNativeBuild({
  graalvmConfigured,
  javaNeedsBuild,
  nativeProvenanceText,
  current,
}) {
  if (!graalvmConfigured) return { needsBuild: false, skipped: true, reasons: [] };
  const reasons = [];
  if (javaNeedsBuild) reasons.push('the Java build is being rebuilt');
  if (nativeProvenanceText == null) {
    reasons.push('no native build at patches/signal-cli/dist-native yet');
  } else {
    const recorded = parseProvenance(nativeProvenanceText);
    reasons.push(...diffSignalCliSources(recorded, current).reasons);
    if (!sameHashList(recorded.nativeFiles, current.nativeFiles ?? [])) {
      reasons.push('patches/signal-cli/native/* changed since the last native build');
    }
  }
  return { needsBuild: reasons.length > 0, skipped: false, reasons };
}

/**
 * What installing does about the native build, given dist-native's PROVENANCE.txt and the
 * installed native copy's (each null when absent): copy it in (`install`), take an installed copy
 * that no longer matches any build out (`retire`: it would otherwise run beside a newer Java
 * build), or nothing.
 */
export function nativeInstallAction(distText, installedText) {
  if (distText != null) return provenanceTextsMatch(distText, installedText) ? 'none' : 'install';
  return installedText != null ? 'retire' : 'none';
}

/**
 * Whether the installed signal-cli copy's PROVENANCE.txt already matches
 * dist's — if so, installing again would be a no-op. `installedText` is
 * `null` when nothing is installed yet.
 */
export function provenanceTextsMatch(distText, installedText) {
  return installedText != null && distText === installedText;
}

/**
 * Digest identifying the AppImage build inputs: a tree hash per tracked
 * path (from `git rev-parse HEAD:<path>`) plus one hash covering whatever's
 * uncommitted under those paths, so dirty-worktree edits count too.
 */
export function computeStampDigest({ treeHashes, dirtyHash }) {
  const sortedKeys = Object.keys(treeHashes).sort();
  const canonical = JSON.stringify({
    treeHashes: Object.fromEntries(sortedKeys.map((k) => [k, treeHashes[k]])),
    dirtyHash,
  });
  return sha256Hex(canonical);
}

/**
 * Paths (relative to the repo root) whose content decides whether the AppImage needs rebuilding:
 * the app sources and everything the production build reads, including the files
 * vite.config.ts pulls in (devserver/: the production CSP, notices, emoji assets), the build
 * wrapper scripts, and the TypeScript and lint configuration.
 */
export const APPIMAGE_STAMP_PATHS = [
  'src',
  'src-tauri',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'public',
  'devserver',
  'scripts/tauri-build.mjs',
  'scripts/gen-rust-notices.mjs',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'eslint.config.js',
];

/**
 * Parses the stored AppImage stamp file's text. Anything that is not a stamp (a missing file, an
 * empty or truncated one, JSON of the wrong shape) is "no stamp": the AppImage is then simply
 * rebuilt, instead of the update failing on the parse.
 */
export function parseStamp(text) {
  if (text == null) return null;
  try {
    const stamp = JSON.parse(text);
    return stamp !== null && typeof stamp === 'object' && typeof stamp.digest === 'string'
      ? stamp
      : null;
  } catch {
    return null;
  }
}

/** Compares two stamps (as returned by computeStampDigest, wrapped in `{digest}`). */
export function stampsEqual(a, b) {
  return a != null && b != null && a.digest === b.digest;
}

/**
 * Minimal `KEY=value` parser for `.snowdrop.local.env`: one assignment per
 * line, blank lines and `#` comments ignored, optional surrounding quotes
 * stripped. Not a general dotenv implementation — just enough for a single
 * local path override.
 */
export function parseEnvFile(text) {
  const result = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[m[1]] = value;
  }
  return result;
}

/**
 * Whether Snowdrop looks like it's currently running, from a list of
 * process command names (e.g. one per line of `ps -e -o comm=`). Matches
 * only exact names, never substrings — a path or title containing
 * "snowdrop" doesn't count, and nothing here ever signals a process to
 * act on the result.
 */
export function isSnowdropProcessRunning(processNames, exactNames = ['snowdrop']) {
  const wanted = new Set(exactNames);
  return processNames.some((name) => wanted.has(name.trim()));
}
