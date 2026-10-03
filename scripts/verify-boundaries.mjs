// Proves the architecture boundary rules (PLAN §3) actually fire.
//
// Lint rules that silently stop matching (a resolver change, a typo in a
// glob) are worse than no rules, so this lints small fixture files placed in
// each layer and asserts the expected violations are reported — and that
// allowed imports are not.
//
// Safety: fixtures only ever create *new* files with a per-process unique
// name (`__boundary_<pid>_<n>__.ts`), never touch existing files, and are
// removed on exit, on SIGINT/SIGTERM, and (leftovers from a killed run) at
// startup.
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const FIXTURE = /^__boundary_.*__\.tsx?$/u;

/** [directory under src/, source, expected rule ids ([] = must be clean)] */
const cases = [
  [
    'core/domain',
    "export { SyncService } from '@/core/services';",
    ['import-x/no-restricted-paths'],
  ],
  ['core/lib', "export type { Message } from '@/core/domain';", ['import-x/no-restricted-paths']],
  ['core/stores', "export { App } from '@/app/App';", ['import-x/no-restricted-paths']],
  [
    'core/services',
    "export { MockBackend } from '@/core/backend/mock';",
    ['import-x/no-restricted-paths'],
  ],
  ['core/services', "export { useState } from 'react';", ['no-restricted-imports']],
  ['core/stores', "export { create } from 'zustand';", ['no-restricted-imports']],
  [
    'ui/primitives',
    "export type { Message } from '@/core/domain';",
    ['import-x/no-restricted-paths'],
  ],
  // Another feature's internals are off limits; its index.ts is the public API.
  ['ui/features/rail', "export * from '../sidebar/model';", ['import-x/no-restricted-paths']],
  ['ui/features/rail', "export * from '../sidebar';", []],
  ['core/stores', "export type { Message } from '@/core/domain';", []],
  ['app', "export { MockBackend } from '@/core/backend/mock';", []],
  ['core/domain', 'const x = 1;\nexport default x;', ['no-restricted-syntax']],
  // Top-level files (the entry point main.tsx) are outside the composition root: no adapters.
  ['', "export { MockBackend } from '@/core/backend/mock';", ['import-x/no-restricted-paths']],
  // ui/hooks sit below features and plugins.
  ['ui/hooks', "export * from '@/ui/features/chat';", ['import-x/no-restricted-paths']],
  ['ui/hooks', "export * from '@/ui/plugins';", ['import-x/no-restricted-paths']],
  ['ui/hooks', "export type { Message } from '@/core/domain';", []],
  // ui/plugins: core, primitives, hooks, and features only through their index.
  [
    'ui/plugins',
    "export * from '@/ui/features/chat/lib/toMarkdown';",
    ['import-x/no-restricted-paths'],
  ],
  ['ui/plugins', "export { toMarkdown } from '@/ui/features/chat';", []],
  ['ui/plugins', "export { useShrike } from '@/ui/hooks';", []],
  ['ui/plugins', "export { createShrike } from '@/app';", ['import-x/no-restricted-paths']],
  [
    'ui/plugins',
    "export { SignalCliBackend } from '@/core/backend/signal-cli';",
    ['import-x/no-restricted-paths'],
  ],
];

/** Removes fixtures left behind by a run that was killed before cleaning up. */
function removeLeftovers(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeLeftovers(full);
    else if (FIXTURE.test(entry.name)) rmSync(full, { force: true });
  }
}

const created = [];
const createdDirs = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const file of created) rmSync(file, { force: true });
  // Deepest first, so parents are empty by the time we reach them.
  for (const dir of createdDirs.sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty (someone added a file meanwhile): leave it.
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

function touch(dir, index, source) {
  const folder = path.join(src, dir);
  const file = path.join(folder, `__boundary_${process.pid}_${index}__.ts`);
  if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);
  for (let d = folder; !existsSync(d); d = path.dirname(d)) createdDirs.push(d);
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, `${source}\n`, { flag: 'wx' });
  created.push(file);
  return file;
}

removeLeftovers(src);
let failures = 0;
try {
  const files = cases.map(([dir, source], i) => touch(dir, i, source));
  const eslint = new ESLint({ cwd: root });
  for (const [i, [, , expected]] of cases.entries()) {
    const file = files[i];
    const [result] = await eslint.lintFiles([file]);
    const rules = [...new Set(result.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`))];
    const ok =
      expected.length === 0 ? rules.length === 0 : expected.every((r) => rules.includes(r));
    const rel = path.relative(root, file);
    if (!ok) {
      failures++;
      console.error(`✗ ${rel}: expected [${expected.join(', ')}], got [${rules.join(', ')}]`);
    } else {
      console.log(`✓ ${rel}${expected.length ? ` → ${expected.join(', ')}` : ' (allowed)'}`);
    }
  }
} finally {
  cleanup();
}

if (failures > 0) {
  console.error(`\n${failures} boundary check(s) failed`);
  process.exit(1);
}
console.log('\nAll boundary rules fire as expected.');
