// Fails when the runtime import graph under src/ has a cycle.
//
// A cycle makes module evaluation order depend on which file happens to load
// first, so a value read at import time can be undefined in one entry point
// and fine in another. The boundary rules (verify-boundaries.mjs) keep layers
// pointing one way; this catches cycles inside a layer, which they can't.
//
// Only edges that exist at runtime count: a whole `import type` /
// `export type` statement is erased, but with verbatimModuleSyntax an
// `import { type A }` still loads its module, so it counts. Dynamic
// `import()` is lazy and doesn't count. Test files are left out; nothing
// imports them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const TEST = /\.test\.tsx?$/u;
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Cycles known when this check was added, each as its sorted members. Shrinks to empty. */
const ALLOWED = [];

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/u.test(name) && !name.endsWith('.d.ts') && !TEST.test(name)) out.push(full);
  }
  return out;
}

function resolve(from, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = path.join(src, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null; // a package
  for (const ext of ['', ...EXTENSIONS]) {
    const candidate = base + ext;
    if (/\.tsx?$/u.test(candidate) && files.has(candidate)) return candidate;
  }
  return null;
}

function runtimeImports(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const out = [];
  for (const node of sf.statements) {
    let specifier;
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) continue;
      specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (node.isTypeOnly) continue;
      specifier = node.moduleSpecifier;
    } else {
      continue;
    }
    if (!ts.isStringLiteral(specifier)) continue;
    const target = resolve(file, specifier.text);
    if (target) out.push(target);
  }
  return out;
}

const files = new Set(sourceFiles(src));
const graph = new Map([...files].map((f) => [f, runtimeImports(f)]));

// Tarjan's strongly connected components, iterative (deep chains overflow recursion).
function components() {
  let index = 0;
  const indexOf = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const result = [];
  for (const start of graph.keys()) {
    if (indexOf.has(start)) continue;
    const work = [[start, 0]];
    indexOf.set(start, index);
    low.set(start, index++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, i] = frame;
      const edges = graph.get(node);
      if (i < edges.length) {
        frame[1]++;
        const next = edges[i];
        if (!indexOf.has(next)) {
          indexOf.set(next, index);
          low.set(next, index++);
          stack.push(next);
          onStack.add(next);
          work.push([next, 0]);
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node), indexOf.get(next)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === indexOf.get(node)) {
        const members = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          members.push(member);
        } while (member !== node);
        const selfLoop = members.length === 1 && edges.includes(node);
        if (members.length > 1 || selfLoop) result.push(members);
      }
    }
  }
  return result;
}

const rel = (f) => path.relative(root, f);
const key = (members) => members.map(rel).sort().join(' ');
const allowed = new Set(ALLOWED.map((members) => [...members].sort().join(' ')));
const found = components();
const unexpected = found.filter((members) => !allowed.has(key(members)));
const stale = [...allowed].filter((k) => !found.some((members) => key(members) === k));

for (const members of unexpected) {
  console.error(`✗ import cycle (${members.length} files):`);
  for (const m of members.map(rel).sort()) console.error(`    ${m}`);
}
for (const k of stale) console.error(`✗ allow-listed cycle is gone; remove it from ALLOWED: ${k}`);
if (unexpected.length > 0 || stale.length > 0) process.exit(1);
console.log(`No import cycles in ${files.size} files (${allowed.size} allow-listed).`);
