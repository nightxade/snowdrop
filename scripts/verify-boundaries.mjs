// Proves the architecture boundary rules (PLAN §3) actually fire.
//
// Lint rules that silently stop matching (a resolver change, a typo in a
// glob) are worse than no rules, so this lints small fixture files placed in
// each layer and asserts the expected violations are reported — and that
// allowed imports are not. Fixtures are written to a temp folder inside src
// (so the TS project and path resolver see them) and always removed.
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [file under src/, source, expected rule ids ([] = must be clean)] */
const cases = [
  [
    'core/domain/__boundary_fixture__.ts',
    "export { SyncService } from '@/core/services';",
    ['import-x/no-restricted-paths'],
  ],
  [
    'core/lib/__boundary_fixture__.ts',
    "export type { Message } from '@/core/domain';",
    ['import-x/no-restricted-paths'],
  ],
  [
    'core/stores/__boundary_fixture__.ts',
    "export { App } from '@/app/App';",
    ['import-x/no-restricted-paths'],
  ],
  [
    'core/services/__boundary_fixture__.ts',
    "export { MockBackend } from '@/core/backend/mock';",
    ['import-x/no-restricted-paths'],
  ],
  [
    'core/services/__boundary_fixture2__.ts',
    "export { useState } from 'react';",
    ['no-restricted-imports'],
  ],
  [
    'core/stores/__boundary_fixture2__.ts',
    "export { create } from 'zustand';",
    ['no-restricted-imports'],
  ],
  [
    'ui/primitives/__boundary_fixture__.ts',
    "export type { Message } from '@/core/domain';",
    ['import-x/no-restricted-paths'],
  ],
  [
    'ui/features/chat/__boundary_fixture__.ts',
    "export * from '../sidebar/__boundary_internal__';",
    ['import-x/no-restricted-paths'],
  ],
  ['ui/features/chat/__boundary_fixture2__.ts', "export * from '../sidebar';", []],
  ['ui/features/sidebar/__boundary_internal__.ts', 'export const x = 1;', []],
  ['ui/features/sidebar/index.ts', "export * from './__boundary_internal__';", []],
  ['core/stores/__boundary_fixture3__.ts', "export type { Message } from '@/core/domain';", []],
  ['app/__boundary_fixture__.ts', "export { MockBackend } from '@/core/backend/mock';", []],
  [
    'core/domain/__boundary_fixture2__.ts',
    'const x = 1;\nexport default x;',
    ['no-restricted-syntax'],
  ],
];

const created = [];
const createdDirs = [];
/** Real files a fixture temporarily replaces (e.g. a feature's index.ts), restored afterwards. */
const backups = new Map();
const touch = (rel, source) => {
  const file = path.join(root, 'src', rel);
  if (existsSync(file)) backups.set(file, readFileSync(file));
  // Remember directories we create so cleanup leaves the tree as it was.
  for (let dir = path.dirname(file); !existsSync(dir); dir = path.dirname(dir))
    createdDirs.push(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${source}\n`);
  created.push(file);
};

let failures = 0;
try {
  for (const [rel, source] of cases) touch(rel, source);

  const eslint = new ESLint({ cwd: root });
  for (const [rel, , expected] of cases) {
    const [result] = await eslint.lintFiles([path.join(root, 'src', rel)]);
    const rules = [...new Set(result.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`))];
    const ok =
      expected.length === 0 ? rules.length === 0 : expected.every((r) => rules.includes(r));
    if (!ok) {
      failures++;
      console.error(`✗ src/${rel}: expected [${expected.join(', ')}], got [${rules.join(', ')}]`);
    } else {
      console.log(`✓ src/${rel}${expected.length ? ` → ${expected.join(', ')}` : ' (allowed)'}`);
    }
  }
} finally {
  for (const file of created) {
    const original = backups.get(file);
    if (original === undefined) rmSync(file, { force: true });
    else writeFileSync(file, original);
  }
  // Deepest first, so parents are empty by the time we reach them.
  for (const dir of createdDirs.sort((a, b) => b.length - a.length)) rmdirSync(dir);
}

if (failures > 0) {
  console.error(`\n${failures} boundary check(s) failed`);
  process.exit(1);
}
console.log('\nAll boundary rules fire as expected.');
