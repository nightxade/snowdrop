#!/usr/bin/env node
// Builds the OPTIONAL bundled signal-cli sidecar, for `npm run
// tauri:build:bundled` only. The default build (`npm run tauri:build`)
// doesn't call this at all: Snowdrop instead downloads signal-cli into the
// app's own data directory the first time it runs (src-tauri/src/
// signal_cli_install.rs), so the app itself stays small and never ships a
// GPL binary in its own package.
//
// Downloads the pinned signal-cli release, verifies it against a pinned
// SHA-256, and installs it as src-tauri/binaries/signal-cli-<target-triple>
// (plus its licence and a pointer to the exact source, which the GPL asks us
// to ship with it). The pinned version, asset name and checksum live in
// src-tauri/signal-cli.json — the one place both this script and the Rust
// downloader (signal_cli_install.rs) read them from.
//
// Usage: node scripts/fetch-signal-cli.mjs [--force]
// A no-op when the pinned version is already installed.
//
// Only Linux x86_64 has a self-contained native build (GraalVM, no Java).
// Other platforms: see docs/DESKTOP.md ("Other platforms").
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'src-tauri');
// ─── Pinned release: the shared source of truth (also read by Rust) ──────
const SIGNAL_CLI = JSON.parse(readFileSync(path.join(tauriDir, 'signal-cli.json'), 'utf8'));
// ─────────────────────────────────────────────────────────────────────────

const REPO = SIGNAL_CLI.repo;
const binDir = path.join(tauriDir, 'binaries');
const cacheDir = path.join(binDir, '.download');
const licenceDir = path.join(tauriDir, 'licenses', 'signal-cli');
const force = process.argv.includes('--force');

function hostTriple() {
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  return `${process.arch}-${process.platform}`;
}

async function download(url, to) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const part = `${to}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  renameSync(part, to);
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function main() {
  const triple = hostTriple();
  const asset = SIGNAL_CLI.assets[triple];
  if (!asset) {
    console.error(
      `[fetch-signal-cli] No pinned native signal-cli for ${triple}. ` +
        'The desktop app can still use a signal-cli you install yourself ' +
        '(Settings → Connection); see docs/DESKTOP.md.',
    );
    process.exit(1);
  }
  const target = path.join(binDir, `signal-cli-${triple}`);
  const stamp = path.join(binDir, `.signal-cli-${triple}.version`);
  if (
    !force &&
    existsSync(target) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').trim() === `${SIGNAL_CLI.version} ${asset.sha256}` &&
    existsSync(path.join(licenceDir, 'COPYING'))
  ) {
    console.log(`[fetch-signal-cli] signal-cli ${SIGNAL_CLI.version} already installed.`);
    return;
  }

  mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, asset.name);
  if (!existsSync(archive) || (await sha256Of(archive)) !== asset.sha256) {
    const url = `${REPO}/releases/download/v${SIGNAL_CLI.version}/${asset.name}`;
    console.log(`[fetch-signal-cli] Downloading ${url}`);
    await download(url, archive);
  }
  const actual = await sha256Of(archive);
  if (actual !== asset.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`);
  }
  console.log(`[fetch-signal-cli] Verified ${asset.name} (sha256 ${actual}).`);

  // The archive holds a single executable (signal-cli-<version>/bin/signal-cli
  // or a bare signal-cli); extract with the system tar and take that file.
  const unpack = path.join(cacheDir, `unpack-${SIGNAL_CLI.version}`);
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', unpack], { stdio: 'inherit' });
  const listing = execFileSync('find', [unpack, '-type', 'f', '-name', 'signal-cli'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  if (listing.length !== 1)
    throw new Error(`Expected one signal-cli binary, found ${listing.length}`);
  mkdirSync(binDir, { recursive: true });
  copyFileSync(listing[0], target);
  chmodSync(target, 0o755);
  rmSync(unpack, { recursive: true, force: true });

  // GPL-3.0: ship the licence text and say exactly where the source is.
  mkdirSync(licenceDir, { recursive: true });
  const licence = path.join(licenceDir, 'COPYING');
  await download(
    `https://raw.githubusercontent.com/AsamK/signal-cli/v${SIGNAL_CLI.version}/LICENSE`,
    licence,
  );
  if (SIGNAL_CLI.licenseSha256 && (await sha256Of(licence)) !== SIGNAL_CLI.licenseSha256) {
    throw new Error('signal-cli LICENSE checksum mismatch');
  }
  writeFileSync(
    path.join(licenceDir, 'SOURCE.txt'),
    [
      `signal-cli ${SIGNAL_CLI.version}`,
      'Copyright (C) the signal-cli authors (AsamK and contributors)',
      'Licence: GNU General Public License v3.0 (see COPYING next to this file)',
      '',
      'Snowdrop ships signal-cli unmodified, as a separate program it starts',
      'and talks to over standard input/output (JSON-RPC). It is not linked',
      'into Snowdrop.',
      '',
      `Release:        ${REPO}/releases/tag/v${SIGNAL_CLI.version}`,
      `Exact source:   ${REPO}/tree/v${SIGNAL_CLI.version}`,
      `Source archive: ${REPO}/archive/refs/tags/v${SIGNAL_CLI.version}.tar.gz`,
      `Binary asset:   ${asset.name} (sha256 ${asset.sha256})`,
      '',
    ].join('\n'),
  );
  writeFileSync(stamp, `${SIGNAL_CLI.version} ${asset.sha256}\n`);
  console.log(`[fetch-signal-cli] Installed ${path.relative(root, target)}.`);
}

main().catch((error) => {
  console.error(`[fetch-signal-cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
