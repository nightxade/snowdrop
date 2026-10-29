/**
 * Settings search shows only the rows whose id is in `pages.ts`
 * (`SettingRow`'s `useSettingsFilter().isVisible`), so a row without an entry
 * silently disappears from every search, and a section id no entry names
 * hides its whole section. This reads the pages' own source, finds every
 * `SettingRow`/`SettingsSection` they render, and checks the index against it
 * in both directions, so a new row can't be forgotten and a renamed one
 * can't leave a stale entry behind.
 *
 * The index is not derived from the rows at render time: the labels,
 * descriptions and keywords it searches are metadata the rows don't carry,
 * and desktop-only, plugin and keybind rows aren't all mounted at once, so a
 * render could not see them all. The source scan can.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES } from './pages';

const sources = import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Ids built at runtime: a plugin's settings, and one row per keybind command. */
const DYNAMIC_ROW_ID = /^(plugin\.|keybind\.)/u;
/** Entries whose rows are not `SettingRow`s (the plugin grid, the keybind list) or are matched by the dynamic ids. */
const NOT_A_ROW = new Set(['plugins.grid', 'keybinds.list']);

interface Found {
  rows: Set<string>;
  sections: Set<string>;
  rowIds: Set<string>;
  dynamic: string[];
}

function scan(): Found {
  const found: Found = { rows: new Set(), sections: new Set(), rowIds: new Set(), dynamic: [] };
  const literal = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };
  for (const [path, text] of Object.entries(sources)) {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText(file);
        if (tag === 'SettingRow' || tag === 'SettingsSection') {
          for (const attr of node.attributes.properties) {
            if (!ts.isJsxAttribute(attr)) continue;
            const name = attr.name.getText(file);
            const init = attr.initializer;
            const expression = init && ts.isJsxExpression(init) ? init.expression : init;
            if (name === 'id') {
              const id = literal(expression);
              if (id === null) found.dynamic.push(`${path}: ${expression?.getText(file)}`);
              else (tag === 'SettingRow' ? found.rows : found.sections).add(id);
            } else if (name === 'rowIds' && tag === 'SettingsSection') {
              if (expression && ts.isArrayLiteralExpression(expression)) {
                for (const element of expression.elements) {
                  const id = literal(element);
                  if (id !== null) found.rowIds.add(id);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

const found = scan();
const entries = SETTINGS_PAGES.flatMap((p) => p.entries);
const indexed = new Set(entries.map((e) => e.id));
const indexedSections = new Set(entries.flatMap((e) => (e.section ? [e.section] : [])));

describe('settings search index', () => {
  it('finds the pages’ rows (the scan itself works)', () => {
    expect(found.rows.size).toBeGreaterThan(40);
    expect(found.rows.has('appearance.theme')).toBe(true);
    expect(found.sections.has('encryption')).toBe(true);
  });

  it('only builds row ids at runtime for the known dynamic families', () => {
    for (const where of found.dynamic) {
      expect(where, 'a new dynamic id needs a decision here').toMatch(/`(plugin|keybind)\./u);
    }
  });

  it('indexes every row the pages render', () => {
    const missing = [...found.rows].filter((id) => !indexed.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it('indexes every row a section lists in rowIds', () => {
    const missing = [...found.rowIds]
      .filter((id) => !DYNAMIC_ROW_ID.test(id) && !indexed.has(id))
      .sort();
    expect(missing).toEqual([]);
  });

  it('has an entry in every section a page renders by id, or the section would hide under search', () => {
    const missing = [...found.sections].filter((id) => !indexedSections.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it('has no entry for a row that no longer exists', () => {
    // A section can also stand for content with no row of its own (via rowIds).
    const stale = [...indexed]
      .filter((id) => !NOT_A_ROW.has(id) && !found.rows.has(id) && !found.rowIds.has(id))
      .sort();
    expect(stale).toEqual([]);
  });

  it('has no entry section that no page renders', () => {
    const stale = [...indexedSections].filter((id) => !found.sections.has(id)).sort();
    expect(stale).toEqual([]);
  });
});
