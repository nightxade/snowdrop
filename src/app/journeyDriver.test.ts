/**
 * The journey build's test driver (journeyDriver.ts) must never reach a normal
 * build. The bundler replaces `import.meta.env.MODE === 'journey'` with a
 * constant, so a dynamic import behind that exact condition (and its chunk) is
 * dropped everywhere else. This walks the module graph's import edges (every
 * import, export-from, dynamic import and require, however the specifier is
 * spelt: relative, `@/` alias, with or without an extension) and requires
 * that each edge into the driver is a dynamic import inside that condition.
 * `npm run journeys` additionally refuses to run when an existing dist/
 * contains the driver.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockBackend } from '@/core/backend/mock';
import type { ConversationId } from '@/core/domain';
import { bootSnowdrop } from '@/test/renderWithSnowdrop';
import { createMemoryStorage } from '@/core/persistence';
import { createSnowdrop } from './createSnowdrop';
import { createJourneyDriver } from './journeyDriver';
import { installBootHelpers } from './installBootHelpers';

const SRC = join(process.cwd(), 'src');
const DRIVER = 'app/journeyDriver';
const GUARD = "import.meta.env.MODE === 'journey'";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** The module a specifier names, as a path under src/ without extension (null for packages). */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null;
  return base === null ? null : relative(SRC, base).replace(/(\/index)?(\.tsx?)?$/u, '');
}

interface Edge {
  file: string;
  dynamic: boolean;
  guarded: boolean;
}

/** Every edge from a source file into the driver. */
function edgesIntoDriver(file: string): Edge[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const edges: Edge[] = [];
  const rel = relative(SRC, file);
  const isGuard = (n: ts.Expression) => n.getText(source).replace(/\s+/gu, ' ') === GUARD;
  const guarded = (node: ts.Node): boolean => {
    let child = node;
    let parent = node.parent;
    while (!ts.isSourceFile(parent)) {
      if (ts.isIfStatement(parent) && parent.thenStatement === child && isGuard(parent.expression))
        return true;
      if (
        ts.isConditionalExpression(parent) &&
        parent.whenTrue === child &&
        isGuard(parent.condition)
      )
        return true;
      child = parent;
      parent = parent.parent;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    let dynamic = false;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isImport || isRequire) && ts.isStringLiteralLike(arg)) {
        specifier = arg.text;
        dynamic = isImport;
      } else if (isImport) {
        // A computed specifier could name the driver: only literals are allowed to import at all.
        throw new Error(`${rel} has a dynamic import with a non-literal specifier`);
      }
    }
    if (specifier !== undefined && resolveSpecifier(file, specifier) === DRIVER)
      edges.push({ file: rel, dynamic, guarded: guarded(node) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

describe('journey driver', () => {
  it('is reached only by dynamic imports behind the journey-mode condition, from the two places that wire it', () => {
    const edges = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== `${DRIVER}.ts`)
      .flatMap(edgesIntoDriver);
    expect(edges.map((e) => e.file).sort()).toEqual([
      'app/backends.ts',
      'app/installBootHelpers.ts',
    ]);
    for (const edge of edges) {
      expect(edge.dynamic, `${edge.file} imports the driver statically`).toBe(true);
      expect(edge.guarded, `${edge.file} imports the driver outside the journey-mode guard`).toBe(
        true,
      );
    }
  });

  it('is not installed outside journey mode', () => {
    const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const stop = installBootHelpers({ snowdrop, safeMode: false });
    expect('__journey' in window).toBe(false);
    stop();
  });
});

describe('journey driver: the preview a chat should show', () => {
  it('leaves out a message the user deleted for themselves, in a chat that is not open', async () => {
    const snowdrop = await bootSnowdrop();
    try {
      const backend = (await snowdrop.backendReady) as MockBackend;
      const driver = createJourneyDriver(snowdrop, backend);
      const id = driver.conversationId('crux') as ConversationId;
      await act(async () => {
        await driver.deliver({ conversation: 'crux', count: 3, text: 'Burst' });
        await snowdrop.sync.idle();
      });
      const row = () => driver.state().conversations.find((c) => c.id === id)!;
      expect(row().expectedPreview).toContain('Burst 3');
      const newest = snowdrop.stores.conversations.getState().lastMessage[id]!;
      expect(newest.body).toBe('Burst 3');
      await act(async () => {
        await snowdrop.send.deleteForMe(id, newest);
      });
      expect(snowdrop.stores.conversations.getState().lastMessage[id]?.body).toBe('Burst 2');
      expect(row().expectedPreview).toContain('Burst 2');
    } finally {
      await snowdrop.dispose();
    }
  });
});
