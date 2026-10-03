/**
 * Every `data-snowdrop` value in the source is a documented style hook, and
 * every documented hook exists: Settings → Custom CSS and THEMING.md both
 * come from (or are checked against) `STYLE_HOOKS`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_HOOKS } from '@/core/themes';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
  });
}

const listed = new Set<string>(STYLE_HOOKS.map((h) => h.hook));
const used = new Map<string, string>();
for (const file of sources('src')) {
  const text = readFileSync(file, 'utf8');
  // JSX attributes (data-snowdrop="x") and prop objects ({ 'data-snowdrop': 'x' }); not
  // CSS selectors ([data-snowdrop='…']), which only look hooks up.
  for (const m of text.matchAll(/(?<!\[)data-snowdrop(?:=|['"]\s*:\s*)["']([a-z0-9-]+)["']/gu))
    used.set(m[1] as string, file);
}

describe('style hooks', () => {
  it('finds the hooks in the source', () => {
    expect(used.size).toBeGreaterThan(30);
  });

  it('lists every data-snowdrop value used in src', () => {
    const missing = [...used].filter(([hook]) => !listed.has(hook)).map(([h, f]) => `${h} (${f})`);
    expect(missing).toEqual([]);
  });

  it('lists only hooks that exist', () => {
    expect([...listed].filter((hook) => !used.has(hook))).toEqual([]);
  });

  it('matches the table in THEMING.md', () => {
    const doc = readFileSync('docs/THEMING.md', 'utf8');
    const table = doc.slice(
      doc.indexOf("**Regions: `[data-snowdrop='…']`.**"),
      doc.indexOf('**Attributes on those elements:**'),
    );
    const documented = [...table.matchAll(/^\| `([a-z0-9-]+)`/gmu)].map((m) => m[1]);
    expect(documented).toEqual(STYLE_HOOKS.map((h) => h.hook));
  });
});
