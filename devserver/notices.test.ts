// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageDirOf, packageDirOfAsset, rustCrateNoticesFile } from './notices';

describe('third-party notices', () => {
  it('finds a package dir from a module id', () => {
    expect(packageDirOf(`/repo${path.sep}node_modules${path.sep}react${path.sep}index.js`)).toBe(
      `/repo${path.sep}node_modules${path.sep}react`,
    );
    // Scoped packages keep the scope segment.
    expect(
      packageDirOf(
        `/repo${path.sep}node_modules${path.sep}@radix-ui${path.sep}react-dialog${path.sep}dist${path.sep}index.js`,
      ),
    ).toBe(`/repo${path.sep}node_modules${path.sep}@radix-ui${path.sep}react-dialog`);
    // Nested (transitive) node_modules resolve to the innermost package.
    expect(
      packageDirOf(
        `/repo${path.sep}node_modules${path.sep}a${path.sep}node_modules${path.sep}b${path.sep}index.js`,
      ),
    ).toBe(`/repo${path.sep}node_modules${path.sep}a${path.sep}node_modules${path.sep}b`);
    expect(packageDirOf('/repo/src/App.tsx')).toBeNull();
  });

  it('finds a package dir from an emitted asset path (CSS-only packages like fonts)', () => {
    expect(
      packageDirOfAsset(
        'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
        '/repo',
      ),
    ).toBe(path.resolve('/repo', 'node_modules/@fontsource-variable/inter'));
    expect(packageDirOfAsset('src/ui/styles/global.css', '/repo')).toBeNull();
  });

  describe('rustCrateNoticesFile', () => {
    let root: string;

    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('reads the generated Rust notices when present', () => {
      root = mkdtempSync(path.join(tmpdir(), 'snowdrop-notices-'));
      mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
      writeFileSync(path.join(root, 'src-tauri', 'THIRD_PARTY_NOTICES-rust.txt'), 'crate notices');
      expect(rustCrateNoticesFile(root)).toBe('crate notices');
    });

    it('returns null when they have not been generated yet', () => {
      root = mkdtempSync(path.join(tmpdir(), 'snowdrop-notices-'));
      expect(rustCrateNoticesFile(root)).toBeNull();
    });
  });
});
