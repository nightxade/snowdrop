/**
 * Themes the pre-unlock screens from the plaintext boot mirror
 * (APPEARANCE_BOOT_KEY) before any vault is open. Exercised against the real
 * jsdom `document` (as themes.test.ts does for applyAppearance) and the real
 * `localStorage` defaultStorage() reads from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { APPEARANCE_BOOT_KEY } from '@/core/persistence';
import { clearAppearance } from '@/core/themes';
import { applyBootAppearance } from './bootAppearance';

afterEach(() => {
  localStorage.removeItem(APPEARANCE_BOOT_KEY);
  clearAppearance(document);
});

describe('applyBootAppearance', () => {
  it('applies the default (standard) shell when nothing was ever mirrored', () => {
    applyBootAppearance(document);
    expect(document.documentElement.hasAttribute('data-shell')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dusk');
  });

  it('applies a mirrored TUI shell choice, with no flash of the standard one', () => {
    localStorage.setItem(
      APPEARANCE_BOOT_KEY,
      JSON.stringify({ themeId: 'linen', density: 'compact', shell: 'tui' }),
    );
    applyBootAppearance(document);
    expect(document.documentElement.getAttribute('data-shell')).toBe('tui');
    expect(document.documentElement.getAttribute('data-theme')).toBe('linen');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('falls back to standard for a malformed or unknown shell value', () => {
    localStorage.setItem(
      APPEARANCE_BOOT_KEY,
      JSON.stringify({ themeId: 'dusk', density: 'comfortable', shell: 'retro' }),
    );
    applyBootAppearance(document);
    expect(document.documentElement.hasAttribute('data-shell')).toBe(false);

    localStorage.setItem(APPEARANCE_BOOT_KEY, 'not json');
    applyBootAppearance(document);
    expect(document.documentElement.hasAttribute('data-shell')).toBe(false);
  });
});
