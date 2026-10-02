/**
 * Settings search: plain, case- and accent-insensitive term matching over
 * page titles and entry labels/descriptions/keywords. Every term must match
 * (so "dark theme" narrows instead of widening). Fuzzy matching was tried
 * and is too loose for settings: "font" would match "notifications".
 */

export interface SettingsEntry {
  id: string;
  /** Section heading id inside the page, so empty sections can hide. */
  section?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

export interface SettingsPageMeta {
  id: string;
  group: string;
  title: string;
  description: string;
  keywords?: readonly string[];
  entries: readonly SettingsEntry[];
}

export interface SettingsMatch {
  pageId: string;
  /** The page itself matched: show everything on it. */
  whole: boolean;
  entryIds: ReadonlySet<string>;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/u).filter(Boolean);
}

const matchesAll = (haystack: string, terms: readonly string[]) =>
  terms.every((t) => haystack.includes(t));

/** Pages (in order) with at least one match; empty query → null (no filtering). */
export function searchSettings(
  query: string,
  pages: readonly SettingsPageMeta[],
): SettingsMatch[] | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  const out: SettingsMatch[] = [];
  for (const page of pages) {
    const pageText = fold([page.title, ...(page.keywords ?? [])].join(' '));
    if (matchesAll(pageText, terms)) {
      out.push({ pageId: page.id, whole: true, entryIds: new Set(page.entries.map((e) => e.id)) });
      continue;
    }
    const ids = new Set<string>();
    for (const entry of page.entries) {
      const text = fold(
        [page.title, entry.label, entry.description ?? '', ...(entry.keywords ?? [])].join(' '),
      );
      if (matchesAll(text, terms)) ids.add(entry.id);
    }
    if (ids.size > 0) out.push({ pageId: page.id, whole: false, entryIds: ids });
  }
  return out;
}
