#!/usr/bin/env node
/**
 * One command to bring a local desktop install up to date, doing only the
 * work that's actually needed:
 *
 *  1. Patched signal-cli — rebuilds (scripts/build-signal-cli.sh) only if
 *     its sources (patches/signal-cli/*.patch, patches/signal-service-java/*,
 *     or the build script itself) changed since dist/'s PROVENANCE.txt was
 *     written, then installs (--install) only if the installed copy's
 *     PROVENANCE.txt differs from dist's. Refuses to install while Snowdrop
 *     looks like it's running.
 *  2. AppImage — rebuilds (npm run tauri:build) only if the app's sources
 *     changed since the last successful build (a stamp file, see
 *     computeAppImageStamp below).
 *  3. JDK — read from SNOWDROP_JDK, else .snowdrop.local.env, else this
 *     prints one-time setup instructions instead of guessing.
 *
 * See docs/DESKTOP.md ("Updating your local install"). The decision logic
 * is pure and unit-tested in scripts/lib/updateState.mjs; this file is just
 * the glue (reading files, shelling out, printing).
 *
 * Usage:
 *   node scripts/desktop-update.mjs [--force] [--skip-appimage]
 *                                   [--skip-signal-cli] [--dry-run]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeStampDigest,
  diffSignalCliSources,
  isSnowdropProcessRunning,
  parseEnvFile,
  parseProvenance,
  provenanceTextsMatch,
  sha256Hex,
  stampsEqual,
} from './lib/updateState.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paths whose content decides whether the AppImage needs rebuilding.
const APPIMAGE_STAMP_PATHS = [
  'src',
  'src-tauri',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'public',
];
const APPIMAGE_STAMP_FILE = path.join(ROOT, '.snowdrop-appimage-stamp.json');
const LOCAL_ENV_FILE = path.join(ROOT, '.snowdrop.local.env');

const SIGNAL_CLI_PATCHES_DIR = path.join(ROOT, 'patches/signal-cli');
const SSJ_PATCHES_DIR = path.join(ROOT, 'patches/signal-service-java');
const BUILD_SCRIPT = path.join(ROOT, 'scripts/build-signal-cli.sh');
const DIST_PROVENANCE = path.join(SIGNAL_CLI_PATCHES_DIR, 'dist/signal-cli/PROVENANCE.txt');
const DIST_BINARY = path.join(SIGNAL_CLI_PATCHES_DIR, 'dist/signal-cli/bin/signal-cli');

function log(msg) {
  console.log(`[desktop-update] ${msg}`);
}
function die(msg) {
  console.error(`[desktop-update] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { force: false, skipAppimage: false, skipSignalCli: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--force') flags.force = true;
    else if (arg === '--skip-appimage') flags.skipAppimage = true;
    else if (arg === '--skip-signal-cli') flags.skipSignalCli = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else
      die(
        `unknown flag '${arg}' (expected --force, --skip-appimage, --skip-signal-cli, --dry-run)`,
      );
  }
  return flags;
}

function appDataDir() {
  if (process.env.SNOWDROP_APP_DATA) return process.env.SNOWDROP_APP_DATA;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(dataHome, 'local.snowdrop.desktop');
}

function readFileIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function hashPatchFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => ({ name, hash: sha256Hex(readFileSync(path.join(dir, name))) }));
}

function currentSignalCliSources() {
  return {
    signalCliPatches: hashPatchFiles(SIGNAL_CLI_PATCHES_DIR),
    ssjPatches: hashPatchFiles(SSJ_PATCHES_DIR),
    buildScriptHash: sha256Hex(readFileSync(BUILD_SCRIPT)),
  };
}

function signalCliVersion(binary) {
  try {
    const output = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    return /^signal-cli\s+(\S+)/.exec(output)?.[1] ?? output;
  } catch {
    return null;
  }
}

// ─── JDK resolution (SNOWDROP_JDK env, else .snowdrop.local.env) ──────────

function resolveJdk() {
  if (process.env.SNOWDROP_JDK) return process.env.SNOWDROP_JDK;
  const text = readFileIfExists(LOCAL_ENV_FILE);
  if (text != null) {
    const jdk = parseEnvFile(text).SNOWDROP_JDK;
    if (jdk) return jdk;
  }
  return null;
}

function printJdkSetupMessage() {
  log('No SNOWDROP_JDK configured.');
  log('scripts/build-signal-cli.sh needs a JDK 25 home to build or install signal-cli.');
  log(`Set it once by creating ${path.relative(ROOT, LOCAL_ENV_FILE)} in the repo root`);
  log("(gitignored — it's your machine's local config, not something to commit):");
  log('');
  log(`  echo 'SNOWDROP_JDK=/path/to/your/jdk-25' > ${path.relative(ROOT, LOCAL_ENV_FILE)}`);
  log('');
  log('Or export SNOWDROP_JDK in your shell environment instead.');
}

// ─── Is Snowdrop running? (never kills anything, just informs the user) ──

function isSnowdropRunning() {
  try {
    const output = execFileSync('ps', ['-e', '-o', 'comm='], { encoding: 'utf8' });
    return isSnowdropProcessRunning(output.split('\n'));
  } catch (err) {
    log(`warning: couldn't check for a running Snowdrop process (${err.message}); proceeding.`);
    return false;
  }
}

// ─── Patched signal-cli: rebuild + install, only as needed ────────────────

function planSignalCli(flags) {
  const current = currentSignalCliSources();
  const distText = readFileIfExists(DIST_PROVENANCE);

  let needsBuild;
  let buildReasons;
  if (flags.force) {
    needsBuild = true;
    buildReasons = ['--force'];
  } else if (distText == null) {
    needsBuild = true;
    buildReasons = ['no build at patches/signal-cli/dist yet'];
  } else {
    const diff = diffSignalCliSources(parseProvenance(distText), current);
    needsBuild = diff.needsRebuild;
    buildReasons = diff.reasons;
  }

  return { current, distText, needsBuild, buildReasons };
}

function runSignalCliStep(flags, plan) {
  const summary = { built: false, installed: false, version: null, blockedReason: null };
  let distText = plan.distText;

  if (plan.needsBuild) {
    log(`signal-cli: rebuild needed (${plan.buildReasons.join('; ')}).`);
    if (flags.dryRun) {
      summary.wouldBuild = true;
    } else {
      const jdk = resolveJdk();
      if (!jdk) {
        printJdkSetupMessage();
        die('cannot build signal-cli without SNOWDROP_JDK.');
      }
      const buildResult = spawnSync(BUILD_SCRIPT, [], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, SNOWDROP_JDK: jdk },
      });
      if (buildResult.status !== 0) die('scripts/build-signal-cli.sh failed (see output above).');
      summary.built = true;
      distText = readFileIfExists(DIST_PROVENANCE);
      if (distText == null) {
        die('build succeeded but patches/signal-cli/dist/signal-cli/PROVENANCE.txt is missing.');
      }
    }
  } else {
    log('signal-cli: build up to date, skipping.');
  }

  const appData = appDataDir();
  const installedProvenancePath = path.join(appData, 'bin/signal-cli-history/PROVENANCE.txt');
  const installedBinary = path.join(appData, 'bin/signal-cli-history/bin/signal-cli');
  const installedText = readFileIfExists(installedProvenancePath);
  const needsInstall = distText != null && !provenanceTextsMatch(distText, installedText);

  if (flags.dryRun) {
    summary.wouldInstall = needsInstall;
    summary.version = signalCliVersion(distText != null ? DIST_BINARY : installedBinary);
    if (needsInstall && isSnowdropRunning())
      summary.blockedReason = 'Snowdrop is currently running';
    log(
      needsInstall
        ? 'signal-cli: install needed (installed copy differs from dist, or nothing is installed yet).'
        : 'signal-cli: installed copy already up to date.',
    );
    if (summary.wouldBuild) {
      log(
        'signal-cli: note — a rebuild changes dist/PROVENANCE.txt, so install would then be needed regardless.',
      );
    }
    return summary;
  }

  if (!needsInstall) {
    log('signal-cli: installed copy already up to date, skipping install.');
    summary.version = signalCliVersion(existsSync(installedBinary) ? installedBinary : DIST_BINARY);
    return summary;
  }

  log(
    'signal-cli: install needed (installed copy differs from dist, or nothing is installed yet).',
  );
  if (isSnowdropRunning()) {
    summary.blockedReason = 'Snowdrop is currently running';
    log('signal-cli: refusing to install while Snowdrop is running. Close Snowdrop and rerun.');
    summary.version = signalCliVersion(DIST_BINARY);
    return summary;
  }

  const jdk = resolveJdk();
  if (!jdk) {
    printJdkSetupMessage();
    die('cannot install signal-cli without SNOWDROP_JDK.');
  }
  const installResult = spawnSync(BUILD_SCRIPT, ['--install'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SNOWDROP_JDK: jdk },
  });
  if (installResult.status !== 0)
    die('scripts/build-signal-cli.sh --install failed (see output above).');
  summary.installed = true;
  summary.version = signalCliVersion(installedBinary);
  return summary;
}

// ─── AppImage: rebuild only if sources changed since the last build ───────

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function treeHashOf(relPath) {
  try {
    return git(['rev-parse', `HEAD:${relPath}`]);
  } catch {
    return 'missing'; // not committed yet — still a valid, stable stamp input
  }
}

function dirtyHashOf(paths) {
  const diff = (() => {
    try {
      return git(['diff', 'HEAD', '--', ...paths]);
    } catch {
      return '';
    }
  })();
  const status = (() => {
    try {
      return git(['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
    } catch {
      return '';
    }
  })();
  const untrackedContent = status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))
    .sort()
    .map((file) => {
      try {
        return `${file}:${sha256Hex(readFileSync(path.join(ROOT, file)))}`;
      } catch {
        return `${file}:unreadable`;
      }
    })
    .join('\n');
  return sha256Hex(`${diff}\n${untrackedContent}`);
}

function computeAppImageStamp() {
  const treeHashes = Object.fromEntries(APPIMAGE_STAMP_PATHS.map((p) => [p, treeHashOf(p)]));
  const dirtyHash = dirtyHashOf(APPIMAGE_STAMP_PATHS);
  return { digest: computeStampDigest({ treeHashes, dirtyHash }), treeHashes, dirtyHash };
}

function bundleDir() {
  const target = process.env.CARGO_TARGET_DIR ?? path.join(ROOT, 'src-tauri/target');
  return path.join(target, 'release/bundle/appimage');
}

function findAppImage() {
  const dir = bundleDir();
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((name) => name.endsWith('.AppImage'));
  return file ? path.join(dir, file) : null;
}

function planAppImage(flags) {
  const current = computeAppImageStamp();
  const stored = (() => {
    const text = readFileIfExists(APPIMAGE_STAMP_FILE);
    return text ? JSON.parse(text) : null;
  })();
  const existingAppImage = findAppImage();

  const reasons = [];
  if (flags.force) reasons.push('--force');
  if (!stored) reasons.push('no previous build stamp found');
  else if (!stampsEqual(current, stored)) reasons.push('app sources changed since the last build');
  if (!existingAppImage) reasons.push('no AppImage found at the expected output path');

  return { current, needsRebuild: reasons.length > 0, reasons, existingAppImage };
}

function runAppImageStep(flags, plan) {
  const summary = { rebuilt: false, path: plan.existingAppImage };
  if (!plan.needsRebuild) {
    log(`AppImage: up to date, skipping (${plan.existingAppImage}).`);
    return summary;
  }

  log(`AppImage: rebuild needed (${plan.reasons.join('; ')}).`);
  if (flags.dryRun) {
    summary.wouldRebuild = true;
    return summary;
  }

  const buildResult = spawnSync('npm', ['run', 'tauri:build'], { cwd: ROOT, stdio: 'inherit' });
  if (buildResult.status !== 0) die('npm run tauri:build failed (see output above).');

  const appImage = findAppImage();
  if (!appImage) die('tauri:build succeeded but no .AppImage was found in the bundle output.');
  writeFileSync(APPIMAGE_STAMP_FILE, JSON.stringify(plan.current, null, 2) + '\n');
  summary.rebuilt = true;
  summary.path = appImage;
  return summary;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.dryRun) log('--dry-run: reporting what would happen, changing nothing.');

  const notes = [];
  let signalCli = { built: false, installed: false, version: null };
  let appImage = { rebuilt: false, path: null };

  if (flags.skipSignalCli) {
    log('signal-cli: --skip-signal-cli, skipping entirely.');
  } else {
    const plan = planSignalCli(flags);
    signalCli = runSignalCliStep(flags, plan);
    if (signalCli.blockedReason) {
      notes.push(`Close Snowdrop, then rerun npm run desktop:update to install signal-cli.`);
    }
  }

  if (flags.skipAppimage) {
    log('AppImage: --skip-appimage, skipping entirely.');
  } else {
    const plan = planAppImage(flags);
    appImage = runAppImageStep(flags, plan);
    if (appImage.rebuilt) {
      notes.push('Quit and relaunch Snowdrop from the new AppImage to use the rebuilt app.');
    }
  }

  console.log('');
  console.log('=== desktop-update summary ===');
  if (flags.skipSignalCli) {
    console.log('signal-cli: skipped (--skip-signal-cli)');
  } else if (flags.dryRun) {
    console.log(
      `signal-cli: would ${signalCli.wouldBuild ? 'rebuild' : 'not rebuild'}, ` +
        `would ${signalCli.wouldInstall ? 'install' : 'not install'}` +
        (signalCli.version ? ` (dist version: ${signalCli.version})` : '') +
        (signalCli.blockedReason ? ` — install would be refused: ${signalCli.blockedReason}` : ''),
    );
  } else {
    console.log(
      `signal-cli: built=${signalCli.built} installed=${signalCli.installed}` +
        (signalCli.version ? ` version=${signalCli.version}` : '') +
        (signalCli.blockedReason ? ` (install refused: ${signalCli.blockedReason})` : ''),
    );
  }
  if (flags.skipAppimage) {
    console.log('AppImage: skipped (--skip-appimage)');
  } else if (flags.dryRun) {
    console.log(
      `AppImage: would ${appImage.wouldRebuild ? 'rebuild' : 'not rebuild'} (${appImage.path ?? 'no existing build found'})`,
    );
  } else {
    console.log(
      `AppImage: rebuilt=${appImage.rebuilt} path=${appImage.path ?? '(none built yet)'}`,
    );
  }
  if (notes.length > 0) {
    console.log('');
    console.log('Next steps:');
    for (const note of notes) console.log(`  - ${note}`);
  }
}

main();
