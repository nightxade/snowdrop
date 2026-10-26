import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Emits dist/THIRD_PARTY_NOTICES.txt from the bundle graph: every package
 * with code *or assets* in the build (transitive dependencies included),
 * with its licence text. Linked from Settings → About.
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

/**
 * Same as `packageDirOf`, but for an emitted asset's `originalFileNames`:
 * project-root-relative paths with `/` separators regardless of platform
 * (Rollup/Rolldown's convention), rather than the absolute, OS-separated
 * module ids chunks carry. This is how fonts like `@fontsource-variable/*`
 * show up: their CSS `@import` pulls in woff2 files as assets, never as JS
 * modules, so they're invisible to `packageDirOf` alone.
 */
export function packageDirOfAsset(relPath: string, root: string): string | null {
  const marker = 'node_modules/';
  const at = relPath.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = relPath.slice(at + marker.length).split('/');
  const name = rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  return name ? path.resolve(root, relPath.slice(0, at + marker.length) + name) : null;
}

/**
 * Programs shipped next to the app rather than bundled into it: the
 * *optional* bundled desktop build (`npm run tauri:build:bundled`) includes
 * signal-cli (GPL-3.0) as a separate executable, so its licence and the
 * location of its exact source go in the notices too. The default desktop
 * build has no bundled program at all — it downloads signal-cli into the
 * app's own data directory the first time it runs instead — so this only
 * runs when `bundled` is set.
 */
export function bundledProgramNotices(root: string): string {
  const dir = path.join(root, 'src-tauri', 'licenses', 'signal-cli');
  const licence = path.join(dir, 'COPYING');
  const source = path.join(dir, 'SOURCE.txt');
  if (!existsSync(licence) || !existsSync(source)) {
    throw new Error(
      'Desktop build without signal-cli licence files: run `node scripts/fetch-signal-cli.mjs` first.',
    );
  }
  const rule = '='.repeat(72);
  return [
    '',
    rule,
    'PROGRAMS SHIPPED WITH THE DESKTOP APP',
    rule,
    '',
    readFileSync(source, 'utf8').trim(),
    '',
    readFileSync(licence, 'utf8').trim(),
    '',
  ].join('\n');
}

/**
 * Serves the Rust side's notices (the crates compiled into the desktop
 * binary, e.g. cssparser/selectors/ring — see src-tauri/about.toml) next to
 * the web notices above, at the same dist root: `src-tauri/
 * THIRD_PARTY_NOTICES-rust.txt` is generated separately (`npm run
 * notices:rust`, docs/DESKTOP.md) since it needs `cargo about`, not Vite's
 * own module graph. A desktop build without it still succeeds — this is
 * attribution for a native dependency tree the web build doesn't even have
 * — but logs a warning so it isn't forgotten before a release.
 */
/** Reads the generated Rust notices, or null if they haven't been (yet). */
export function rustCrateNoticesFile(root: string): string | null {
  const file = path.join(root, 'src-tauri', 'THIRD_PARTY_NOTICES-rust.txt');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function rustCrateNotices(): Plugin {
  return {
    name: 'snowdrop:rust-crate-notices',
    apply: 'build',
    generateBundle() {
      const text = rustCrateNoticesFile(process.cwd());
      if (text === null) {
        this.warn(
          'src-tauri/THIRD_PARTY_NOTICES-rust.txt is missing (run `npm run notices:rust`); ' +
            'the desktop build will ship without Rust crate attribution.',
        );
        return;
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES-rust.txt', source: text });
    },
  };
}

/**
 * `wasm-media-encoders` (MIT) ships LAME, the MP3 encoder, as a separate
 * `mp3.wasm` file; LAME is LGPL, which its MIT wrapper's licence file doesn't
 * say. Voice notes use it, so its terms and where to get the source are
 * stated next to the package's own notice.
 */
export const LAME_NOTICE = [
  'wasm-media-encoders includes LAME (https://lame.sourceforge.io/), the MP3 encoder,',
  'compiled to WebAssembly. LAME is licensed under the GNU Lesser General Public',
  'License, version 2 or (at your option) any later version',
  '(https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html). Snowdrop ships it',
  'unmodified as its own file (mp3.wasm), loaded at run time and not linked into',
  "Snowdrop's code, so it can be replaced with another build of LAME. The source",
  'of the build used is at https://github.com/arseneyr/wasm-media-encoders.',
].join('\n');

export function thirdPartyNotices({ bundled = false }: { bundled?: boolean } = {}): Plugin {
  return {
    name: 'snowdrop:third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          for (const id of Object.keys(file.modules)) {
            const dir = packageDirOf(id.replace(/^\0/u, '').split('?')[0] ?? '');
            if (dir) dirs.add(dir);
          }
        } else {
          // Assets (fonts, images, …) pulled in through CSS rather than JS:
          // not part of any chunk's module graph, but still shipped.
          for (const name of file.originalFileNames) {
            const dir = packageDirOfAsset(name, process.cwd());
            if (dir) dirs.add(dir);
          }
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
      const lame = entries.some((e) => e.name === 'wasm-media-encoders')
        ? `\n${'='.repeat(72)}\nLAME (inside wasm-media-encoders)\n${'='.repeat(72)}\n\n${LAME_NOTICE}\n`
        : '';
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: `Snowdrop includes the following third-party software (${entries.length} packages).\n\n${body}${lame}${bundled ? bundledProgramNotices(process.cwd()) : ''}`,
      });
    },
  };
}
