import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, LICENCES } from './licences.generated';

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'OFL-1.1']);

describe('About → licences', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
    dependencies: Record<string, string>;
  };

  it('lists exactly the runtime dependencies (re-run scripts/gen-licences.mjs if this fails)', () => {
    expect(LICENCES.map((l) => l.name)).toEqual(Object.keys(pkg.dependencies).sort());
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('records versions that satisfy package.json and permissive licences only', () => {
    for (const l of LICENCES) {
      const wanted = (pkg.dependencies[l.name] ?? '').replace(/^[\^~]/u, '');
      expect(l.version.split('.')[0], l.name).toBe(wanted.split('.')[0]);
      // A dual licence ("MIT OR Apache-2.0") is fine when either choice is.
      const choices = l.license.replace(/^\(|\)$/gu, '').split(/\s+OR\s+/u);
      expect(
        choices.some((c) => ALLOWED.has(c)),
        `${l.name}: ${l.license}`,
      ).toBe(true);
    }
  });
});
