import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Emits dist/THIRD_PARTY_NOTICES.txt from the bundle graph: every package
 * with code in the build (transitive dependencies included), with its
 * licence text. Linked from Settings → About.
 */
const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'license',
  'license.md',
];

export function packageDirOf(id: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = id.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = id.slice(at + marker.length).split(path.sep);
  const name = rest[0]?.startsWith('@') ? rest.slice(0, 2).join(path.sep) : rest[0];
  return name ? id.slice(0, at + marker.length) + name : null;
}

export function thirdPartyNotices(): Plugin {
  return {
    name: 'snowdrop:third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        for (const id of Object.keys(file.modules)) {
          const dir = packageDirOf(id.replace(/^\0/u, '').split('?')[0] ?? '');
          if (dir) dirs.add(dir);
        }
      }
      const entries = [...dirs]
        .map((dir) => {
          const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            name: string;
            version: string;
            license?: string | { type?: string };
          };
          const license =
            typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
          const file = LICENSE_FILES.map((f) => path.join(dir, f)).find((f) => existsSync(f));
          const text = file
            ? readFileSync(file, 'utf8').trim()
            : `(${license}; no licence file shipped)`;
          return { name: pkg.name, version: pkg.version, license, text };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const body = entries
        .map(
          (e) =>
            `${'='.repeat(72)}\n${e.name} ${e.version} (${e.license})\n${'='.repeat(72)}\n\n${e.text}\n`,
        )
        .join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: `Snowdrop includes the following third-party software (${entries.length} packages).\n\n${body}`,
      });
    },
  };
}
