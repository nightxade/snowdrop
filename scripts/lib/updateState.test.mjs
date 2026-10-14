// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  computeStampDigest,
  diffSignalCliSources,
  isSnowdropProcessRunning,
  parseEnvFile,
  parseProvenance,
  provenanceTextsMatch,
  sha256Hex,
  stampsEqual,
} from './updateState.mjs';

const SAMPLE_PROVENANCE = `Upstream commit: 22b028bbb9cee8f6aa22af71c6b3e9d09028a16a (v0.14.8)
Build script sha256: aaaa000000000000000000000000000000000000000000000000000000000001
Built: 2026-10-14T03:21:28Z
JDK: openjdk version "25.0.4.1" 2026-08-18 LTS
jlink modules: java.base,java.desktop

Patches applied (sha256, in order):
  1111111111111111111111111111111111111111111111111111111111111111  0001-a.patch
  2222222222222222222222222222222222222222222222222222222222222222  0002-b.patch

signal-service-java upstream commit: d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0 (v2.15.3_unofficial_153)
signal-service-java patched version: 2.15.3_unofficial_153-snowdrop.1
signal-service-java patches applied (sha256, in order):
  3333333333333333333333333333333333333333333333333333333333333333  0001-ssj.patch
`;

// A real PROVENANCE.txt written before this script started recording a
// build-script hash (patches/signal-cli/dist currently looks like this).
const OLD_PROVENANCE_NO_BUILD_SCRIPT_HASH = `Upstream commit: 22b028bbb9cee8f6aa22af71c6b3e9d09028a16a (v0.14.8)
Built: 2026-10-13T08:57:24Z
JDK: openjdk version "25.0.4.1" 2026-08-18 LTS
jlink modules: java.base,java.desktop

Patches applied (sha256, in order):
  1111111111111111111111111111111111111111111111111111111111111111  0001-a.patch

signal-service-java upstream commit: d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0 (v2.15.3_unofficial_153)
signal-service-java patched version: 2.15.3_unofficial_153-snowdrop.1
signal-service-java patches applied (sha256, in order):
  3333333333333333333333333333333333333333333333333333333333333333  0001-ssj.patch
`;

describe('sha256Hex', () => {
  it('matches a known sha256 digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('parseProvenance', () => {
  it('parses every field, including both patch lists', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    expect(parsed.upstreamCommit).toBe('22b028bbb9cee8f6aa22af71c6b3e9d09028a16a');
    expect(parsed.buildScriptHash).toBe(
      'aaaa000000000000000000000000000000000000000000000000000000000001',
    );
    expect(parsed.builtAt).toBe('2026-10-14T03:21:28Z');
    expect(parsed.patches).toEqual([
      {
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        name: '0001-a.patch',
      },
      {
        hash: '2222222222222222222222222222222222222222222222222222222222222222',
        name: '0002-b.patch',
      },
    ]);
    expect(parsed.ssjUpstreamCommit).toBe('d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0');
    expect(parsed.ssjPatchedVersion).toBe('2.15.3_unofficial_153-snowdrop.1');
    expect(parsed.ssjPatches).toEqual([
      {
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        name: '0001-ssj.patch',
      },
    ]);
  });

  it('leaves buildScriptHash null for provenance written before it was tracked', () => {
    const parsed = parseProvenance(OLD_PROVENANCE_NO_BUILD_SCRIPT_HASH);
    expect(parsed.buildScriptHash).toBeNull();
    expect(parsed.patches).toHaveLength(1);
  });
});

describe('diffSignalCliSources', () => {
  const current = {
    signalCliPatches: [
      {
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        name: '0001-a.patch',
      },
      {
        hash: '2222222222222222222222222222222222222222222222222222222222222222',
        name: '0002-b.patch',
      },
    ],
    ssjPatches: [
      {
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        name: '0001-ssj.patch',
      },
    ],
    buildScriptHash: 'aaaa000000000000000000000000000000000000000000000000000000000001',
  };

  it('reports no rebuild needed when everything matches', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    expect(diffSignalCliSources(parsed, current)).toEqual({ needsRebuild: false, reasons: [] });
  });

  it('flags a changed signal-cli patch', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    const edited = {
      ...current,
      signalCliPatches: [
        current.signalCliPatches[0],
        { ...current.signalCliPatches[1], hash: 'f'.repeat(68) },
      ],
    };
    const result = diffSignalCliSources(parsed, edited);
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain('patches/signal-cli/*.patch changed since the last build');
  });

  it('flags a changed signal-service-java patch', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    const edited = { ...current, ssjPatches: [{ hash: 'b'.repeat(68), name: '0001-ssj.patch' }] };
    const result = diffSignalCliSources(parsed, edited);
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain(
      'patches/signal-service-java/*.patch changed since the last build',
    );
  });

  it('flags a changed build script', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    const edited = { ...current, buildScriptHash: 'c'.repeat(68) };
    const result = diffSignalCliSources(parsed, edited);
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain('scripts/build-signal-cli.sh changed since the last build');
  });

  it('treats a missing recorded build-script hash as needing a rebuild', () => {
    const parsed = parseProvenance(OLD_PROVENANCE_NO_BUILD_SCRIPT_HASH);
    const result = diffSignalCliSources(parsed, {
      signalCliPatches: parsed.patches,
      ssjPatches: parsed.ssjPatches,
      buildScriptHash: current.buildScriptHash,
    });
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain('recorded provenance predates build-script hash tracking');
  });

  it('is order-independent (sorts patches by name before comparing)', () => {
    const parsed = parseProvenance(SAMPLE_PROVENANCE);
    const reordered = { ...current, signalCliPatches: [...current.signalCliPatches].reverse() };
    expect(diffSignalCliSources(parsed, reordered).needsRebuild).toBe(false);
  });
});

describe('provenanceTextsMatch', () => {
  it('is false when nothing is installed', () => {
    expect(provenanceTextsMatch(SAMPLE_PROVENANCE, null)).toBe(false);
  });

  it('is true for an exact copy (e.g. right after an install)', () => {
    expect(provenanceTextsMatch(SAMPLE_PROVENANCE, SAMPLE_PROVENANCE)).toBe(true);
  });

  it('is false when the installed copy is an older build', () => {
    expect(provenanceTextsMatch(SAMPLE_PROVENANCE, OLD_PROVENANCE_NO_BUILD_SCRIPT_HASH)).toBe(
      false,
    );
  });
});

describe('computeStampDigest / stampsEqual', () => {
  it('is stable for the same inputs regardless of key order', () => {
    const a = computeStampDigest({ treeHashes: { src: 'h1', public: 'h2' }, dirtyHash: 'd1' });
    const b = computeStampDigest({ treeHashes: { public: 'h2', src: 'h1' }, dirtyHash: 'd1' });
    expect(a).toBe(b);
    expect(stampsEqual({ digest: a }, { digest: b })).toBe(true);
  });

  it('changes when a tracked path tree hash changes', () => {
    const a = computeStampDigest({ treeHashes: { src: 'h1' }, dirtyHash: 'd1' });
    const b = computeStampDigest({ treeHashes: { src: 'h1-edited' }, dirtyHash: 'd1' });
    expect(a).not.toBe(b);
  });

  it('changes when the dirty-worktree hash changes (uncommitted edits)', () => {
    const a = computeStampDigest({ treeHashes: { src: 'h1' }, dirtyHash: 'clean' });
    const b = computeStampDigest({ treeHashes: { src: 'h1' }, dirtyHash: 'dirty' });
    expect(a).not.toBe(b);
    expect(stampsEqual({ digest: a }, { digest: b })).toBe(false);
  });

  it('stampsEqual is false against a missing stamp', () => {
    expect(stampsEqual(null, { digest: 'x' })).toBe(false);
    expect(stampsEqual({ digest: 'x' }, null)).toBe(false);
    expect(stampsEqual(undefined, undefined)).toBe(false);
  });
});

describe('parseEnvFile', () => {
  it('parses a simple assignment', () => {
    expect(parseEnvFile('SNOWDROP_JDK=/opt/jdk-25\n')).toEqual({ SNOWDROP_JDK: '/opt/jdk-25' });
  });

  it('ignores blank lines and comments', () => {
    const text = '# local config, gitignored\n\nSNOWDROP_JDK=/opt/jdk-25\n# trailing comment\n';
    expect(parseEnvFile(text)).toEqual({ SNOWDROP_JDK: '/opt/jdk-25' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile('SNOWDROP_JDK="/opt/jdk 25"\n')).toEqual({
      SNOWDROP_JDK: '/opt/jdk 25',
    });
    expect(parseEnvFile("SNOWDROP_JDK='/opt/jdk-25'\n")).toEqual({
      SNOWDROP_JDK: '/opt/jdk-25',
    });
  });

  it('ignores lines that are not KEY=value', () => {
    expect(parseEnvFile('not an assignment\nSNOWDROP_JDK=/opt/jdk-25\n')).toEqual({
      SNOWDROP_JDK: '/opt/jdk-25',
    });
  });
});

describe('isSnowdropProcessRunning', () => {
  it('matches the exact binary name', () => {
    expect(isSnowdropProcessRunning(['bash', 'snowdrop', 'node'])).toBe(true);
  });

  it('does not match a substring or a different case', () => {
    expect(isSnowdropProcessRunning(['snowdrop-helper', 'Snowdrop', 'my-snowdrop-script'])).toBe(
      false,
    );
  });

  it('is false for an empty process list', () => {
    expect(isSnowdropProcessRunning([])).toBe(false);
  });

  it('trims whitespace from process names', () => {
    expect(isSnowdropProcessRunning(['  snowdrop  '])).toBe(true);
  });
});
