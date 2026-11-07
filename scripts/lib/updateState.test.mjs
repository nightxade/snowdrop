// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  APPIMAGE_STAMP_PATHS,
  computeStampDigest,
  diffSignalCliSources,
  isSnowdropProcessRunning,
  nativeInstallAction,
  parseEnvFile,
  parseProvenance,
  parseStamp,
  planNativeBuild,
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

const NATIVE_PROVENANCE =
  SAMPLE_PROVENANCE.replace(
    'jlink modules: java.base,java.desktop',
    'Build kind: native image\nGraalVM: openjdk version "25.0.4.1" 2026-08-18\nlibsignal_jni.so sha256: ' +
      'f'.repeat(64),
  ) + `\nNative build files (sha256):\n  ${'5'.repeat(64)}  gen-native-metadata.py\n`;

describe('native provenance', () => {
  it('parses with the same fields as the Java build, plus the native build files', () => {
    expect(parseProvenance(NATIVE_PROVENANCE)).toEqual({
      ...parseProvenance(SAMPLE_PROVENANCE),
      nativeFiles: [{ name: 'gen-native-metadata.py', hash: '5'.repeat(64) }],
    });
  });
});

describe('planNativeBuild', () => {
  const current = {
    signalCliPatches: [
      { name: '0001-a.patch', hash: '1'.repeat(64) },
      { name: '0002-b.patch', hash: '2'.repeat(64) },
    ],
    ssjPatches: [{ name: '0001-ssj.patch', hash: '3'.repeat(64) }],
    buildScriptHash: 'aaaa000000000000000000000000000000000000000000000000000000000001',
    nativeFiles: [{ name: 'gen-native-metadata.py', hash: '5'.repeat(64) }],
  };

  it('does nothing, and says why, without a GraalVM', () => {
    expect(
      planNativeBuild({
        graalvmConfigured: false,
        javaNeedsBuild: true,
        nativeProvenanceText: null,
        current,
      }),
    ).toEqual({ needsBuild: false, skipped: true, reasons: [] });
  });

  it('builds when there is no native build yet', () => {
    const plan = planNativeBuild({
      graalvmConfigured: true,
      javaNeedsBuild: false,
      nativeProvenanceText: null,
      current,
    });
    expect(plan.needsBuild).toBe(true);
    expect(plan.reasons).toEqual(['no native build at patches/signal-cli/dist-native yet']);
  });

  it('is up to date when it was built from these sources', () => {
    const plan = planNativeBuild({
      graalvmConfigured: true,
      javaNeedsBuild: false,
      nativeProvenanceText: NATIVE_PROVENANCE,
      current,
    });
    expect(plan).toEqual({ needsBuild: false, skipped: false, reasons: [] });
  });

  it('rebuilds when a patch changed since the native build', () => {
    const plan = planNativeBuild({
      graalvmConfigured: true,
      javaNeedsBuild: false,
      nativeProvenanceText: NATIVE_PROVENANCE,
      current: {
        ...current,
        signalCliPatches: [
          ...current.signalCliPatches,
          { name: '0003-c.patch', hash: '4'.repeat(64) },
        ],
      },
    });
    expect(plan.needsBuild).toBe(true);
    expect(plan.reasons).toEqual(['patches/signal-cli/*.patch changed since the last build']);
  });

  it('rebuilds when a file only the native build uses changed', () => {
    const plan = planNativeBuild({
      graalvmConfigured: true,
      javaNeedsBuild: false,
      nativeProvenanceText: NATIVE_PROVENANCE,
      current: {
        ...current,
        nativeFiles: [{ name: 'gen-native-metadata.py', hash: '6'.repeat(64) }],
      },
    });
    expect(plan.needsBuild).toBe(true);
    expect(plan.reasons).toEqual([
      'patches/signal-cli/native/* changed since the last native build',
    ]);
  });

  it('rebuilds whenever the Java build it is made from is rebuilt', () => {
    const plan = planNativeBuild({
      graalvmConfigured: true,
      javaNeedsBuild: true,
      nativeProvenanceText: NATIVE_PROVENANCE,
      current,
    });
    expect(plan.needsBuild).toBe(true);
    expect(plan.reasons).toEqual(['the Java build is being rebuilt']);
  });
});

describe('nativeInstallAction', () => {
  it('installs a native build that is not installed yet, or differs', () => {
    expect(nativeInstallAction(NATIVE_PROVENANCE, null)).toBe('install');
    expect(nativeInstallAction(NATIVE_PROVENANCE, NATIVE_PROVENANCE + 'x')).toBe('install');
  });

  it('leaves an identical installed copy alone', () => {
    expect(nativeInstallAction(NATIVE_PROVENANCE, NATIVE_PROVENANCE)).toBe('none');
  });

  it('retires an installed native build that no build matches any more', () => {
    expect(nativeInstallAction(null, NATIVE_PROVENANCE)).toBe('retire');
  });

  it('does nothing when there is no native build anywhere', () => {
    expect(nativeInstallAction(null, null)).toBe('none');
  });
});

describe('publish script tracking', () => {
  const withScript = `${SAMPLE_PROVENANCE.replace(
    'signal-service-java patches applied',
    'signal-service-java publish script sha256: ' +
      'c'.repeat(64) +
      '\nsignal-service-java patches applied',
  )}`;
  const current = {
    signalCliPatches: parseProvenance(SAMPLE_PROVENANCE).patches,
    ssjPatches: parseProvenance(SAMPLE_PROVENANCE).ssjPatches,
    buildScriptHash: 'aaaa000000000000000000000000000000000000000000000000000000000001',
    ssjPublishScriptHash: 'c'.repeat(64),
  };

  it('parses the recorded hash', () => {
    expect(parseProvenance(withScript).ssjPublishScriptHash).toBe('c'.repeat(64));
    expect(parseProvenance(SAMPLE_PROVENANCE).ssjPublishScriptHash).toBeNull();
  });

  it('is current when the hashes match', () => {
    expect(diffSignalCliSources(parseProvenance(withScript), current).needsRebuild).toBe(false);
  });

  it('flags a changed publish script', () => {
    const result = diffSignalCliSources(parseProvenance(withScript), {
      ...current,
      ssjPublishScriptHash: 'd'.repeat(64),
    });
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain(
      'patches/signal-service-java/publish-local.init.gradle.kts changed since the last build',
    );
  });

  it('flags provenance written before the script was tracked', () => {
    const result = diffSignalCliSources(parseProvenance(SAMPLE_PROVENANCE), current);
    expect(result.needsRebuild).toBe(true);
    expect(result.reasons).toContain('recorded provenance predates publish-script hash tracking');
  });
});

describe('APPIMAGE_STAMP_PATHS', () => {
  it('covers what the production build reads beyond src', () => {
    for (const p of [
      'devserver',
      'scripts/tauri-build.mjs',
      'tsconfig.app.json',
      'eslint.config.js',
    ]) {
      expect(APPIMAGE_STAMP_PATHS).toContain(p);
    }
    expect(new Set(APPIMAGE_STAMP_PATHS).size).toBe(APPIMAGE_STAMP_PATHS.length);
  });
});

describe('parseStamp', () => {
  it('reads a valid stamp', () => {
    expect(parseStamp('{"digest":"abc","treeHashes":{}}')).toEqual({
      digest: 'abc',
      treeHashes: {},
    });
  });

  it('treats a missing, empty, truncated or mis-shaped stamp as no stamp', () => {
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp('')).toBeNull();
    expect(parseStamp('{"digest":"ab')).toBeNull();
    expect(parseStamp('null')).toBeNull();
    expect(parseStamp('[]')).toBeNull();
    expect(parseStamp('{"digest":5}')).toBeNull();
  });
});
