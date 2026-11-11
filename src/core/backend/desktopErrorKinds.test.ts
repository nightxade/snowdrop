import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_ERROR_KINDS } from './desktop';

const RUST_ERROR_FILE = join(process.cwd(), 'src-tauri', 'src', 'error.rs');

/** `KeyringUnavailable` as serde's `rename_all = "kebab-case"` writes it. */
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** The serialized names of the variants of Rust's `ErrorKind`. */
function rustErrorKinds(source: string): string[] {
  const header = source.indexOf('pub enum ErrorKind {');
  if (header < 0) throw new Error('ErrorKind not found');
  // The derive and serde attributes sit just above the enum.
  const attributes = source.slice(Math.max(0, header - 200), header);
  if (!attributes.includes('rename_all = "kebab-case"'))
    throw new Error('ErrorKind no longer uses kebab-case; teach this test the new rule');
  const end = source.indexOf('\n}', header);
  const body = source
    .slice(header + 'pub enum ErrorKind {'.length, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  // A per-variant rename would change a name this test derives from the identifier.
  if (body.includes('#[serde')) throw new Error('a variant has its own serde attribute');
  return [...body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,/gm)].map((m) => kebab(m[1] as string));
}

const sorted = (kinds: readonly string[]) => [...kinds].sort();

describe('desktop error kinds', () => {
  it('match the variants of the Rust ErrorKind exactly', () => {
    const rust = rustErrorKinds(readFileSync(RUST_ERROR_FILE, 'utf8'));
    expect(rust.length).toBeGreaterThan(10);
    expect(sorted(DESKTOP_ERROR_KINDS)).toEqual(sorted(rust));
  });

  it('are noticed when a Rust variant has no TypeScript kind', () => {
    const source = readFileSync(RUST_ERROR_FILE, 'utf8').replace(
      /^\s*StorageLocked,\n/m,
      '    StorageLocked,\n    BrandNewKind,\n',
    );
    expect(sorted(DESKTOP_ERROR_KINDS)).not.toEqual(sorted(rustErrorKinds(source)));
  });

  it('are noticed when a TypeScript kind has no Rust variant', () => {
    const source = readFileSync(RUST_ERROR_FILE, 'utf8').replace(/^\s*Timeout,\n/m, '');
    expect(sorted(DESKTOP_ERROR_KINDS)).not.toEqual(sorted(rustErrorKinds(source)));
  });
});
