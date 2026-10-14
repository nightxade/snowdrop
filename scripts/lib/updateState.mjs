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
    ssjPatches: [],
  };

  let section = null; // 'patches' | 'ssjPatches' | null
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
    } else if (line === 'signal-service-java patches applied (sha256, in order):') {
      section = 'ssjPatches';
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
 * `current` is `{ signalCliPatches, ssjPatches, buildScriptHash }`, each
 * patch list `{name, hash}[]`. Returns `{needsRebuild, reasons}`; `reasons`
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
  return { needsRebuild: reasons.length > 0, reasons };
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
