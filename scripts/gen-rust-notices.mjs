#!/usr/bin/env node
// Writes src-tauri/THIRD_PARTY_NOTICES-rust.txt: the licence texts of every
// Rust crate compiled into the release binary (src-tauri/Cargo.lock minus
// build- and dev-only dependencies — see src-tauri/about.toml), deduplicated
// by exact licence text, each followed by the crate(s) that use it.
//
// Requires `cargo about` (https://github.com/EmbarkStudios/cargo-about):
//   cargo install cargo-about --locked --features cli
//
// Usage: node scripts/gen-rust-notices.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'src-tauri');
const out = path.join(tauriDir, 'THIRD_PARTY_NOTICES-rust.txt');

function cargoAbout(args) {
  try {
    // The JSON form embeds every licence text at least once per crate that
    // uses it, easily tens of megabytes before deduplication — well past
    // execFileSync's 1 MB default.
    return execFileSync('cargo', ['about', ...args], {
      cwd: tauriDir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `\`cargo about ${args.join(' ')}\` failed. Is cargo-about installed? ` +
        '(`cargo install cargo-about --locked --features cli`)\n' +
        (error.stderr ?? error.message),
    );
  }
}

// The JSON form carries the same data as the handlebars render, but as
// plain objects — easiest way to get the crate/licence counts for the header.
const data = JSON.parse(cargoAbout(['generate', '--format', 'json']));
const crateCount = data.crates.length;
const licenceCount = data.licenses.length;

const body = cargoAbout(['generate', path.join(tauriDir, 'about.hbs')]);

const header = [
  `Snowdrop statically links the following ${crateCount} third-party Rust crates`,
  `(${licenceCount} distinct licence texts after deduplication). Each text below is`,
  'followed by the crate(s) that use it.',
  '',
  '',
].join('\n');

writeFileSync(out, header + body.trimStart());
console.log(`[gen-rust-notices] wrote ${path.relative(root, out)} (${crateCount} crates, ${licenceCount} licence texts).`);
