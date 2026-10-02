import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES } from './pages';
import { searchSettings } from './search';

describe('settings search', () => {
  it('returns null (no filtering) for an empty query', () => {
    expect(searchSettings('   ', SETTINGS_PAGES)).toBeNull();
  });

  it('finds rows by label, description and keywords across pages', () => {
    const result = searchSettings('compact', SETTINGS_PAGES)!;
    const appearance = result.find((m) => m.pageId === 'appearance')!;
    expect(appearance.whole).toBe(false);
    expect([...appearance.entryIds]).toEqual(
      expect.arrayContaining(['appearance.density', 'appearance.compactAvatars']),
    );
    expect(appearance.entryIds.has('appearance.theme')).toBe(false);
  });

  it('shows a whole page when its title matches', () => {
    const [match] = searchSettings('keybinds', SETTINGS_PAGES)!;
    expect(match).toMatchObject({ pageId: 'keybinds', whole: true });
  });

  it('requires every term and ignores case and accents', () => {
    expect(searchSettings('READ réceipts', SETTINGS_PAGES)!.map((m) => m.pageId)).toEqual([
      'privacy',
    ]);
    expect(searchSettings('receipts zebra', SETTINGS_PAGES)).toEqual([]);
  });

  it('every entry id is unique so rows can be targeted', () => {
    const ids = SETTINGS_PAGES.flatMap((p) => p.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
