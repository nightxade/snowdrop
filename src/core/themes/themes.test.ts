import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES, findTheme, LINEN } from './builtin';
import {
  adjustLightness,
  contrastRatio,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  toHex,
  withAlpha,
} from './color';
import {
  applyAppearance,
  buildThemeCss,
  clearAppearance,
  deriveAccentTokens,
  STYLE_IDS,
  type AppearanceInput,
} from './engine';
import { isTokenName } from './tokens';

const base: AppearanceInput = {
  themeId: 'dusk',
  accent: null,
  density: 'comfortable',
  shell: 'standard',
  fontSize: 15,
  zoom: 1,
  saturation: 1,
  reducedMotion: 'system',
  customCss: '',
};

describe('color math', () => {
  it('round-trips hex through OKLCH', () => {
    for (const hex of ['#d4744a', '#000000', '#ffffff', '#3ccf91', '#4a68c4']) {
      expect(toHex(oklchToRgb(rgbToOklch(parseHex(hex)!)))).toBe(hex);
    }
    expect(parseHex('#abc')).toEqual(parseHex('#aabbcc'));
    expect(parseHex('nope')).toBeNull();
  });

  it('shifts lightness while keeping hue, staying in gamut', () => {
    const base = rgbToOklch(parseHex('#d4744a')!);
    const lighter = rgbToOklch(parseHex(adjustLightness('#d4744a', 0.08))!);
    expect(lighter.l).toBeGreaterThan(base.l);
    expect(Math.abs(lighter.h - base.h)).toBeLessThan(3);
    expect(adjustLightness('#ffffff', 0.2)).toBe('#ffffff');
  });

  it('computes contrast and alpha', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(withAlpha('#d4744a', 0.1)).toBe('rgba(212, 116, 74, 0.1)');
  });
});

describe('themes', () => {
  it('only override known tokens', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const name of Object.keys(theme.tokens)) expect(isTokenName(name)).toBe(true);
    }
    expect(findTheme('missing').id).toBe('dusk');
  });

  it('keep body text contrast ≥ 4.5:1 on chat surfaces', () => {
    const duskChat = '#1b1d22';
    for (const theme of BUILTIN_THEMES) {
      const bg = theme.tokens['bg-chat'] ?? duskChat;
      const text = theme.tokens.text ?? '#e6e8eb';
      const muted = theme.tokens['text-muted'] ?? '#aaadb2';
      expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('derives an accent family appropriate to the theme kind', () => {
    const dark = deriveAccentTokens('#3ccf91', 'dark');
    const light = deriveAccentTokens('#3ccf91', 'light');
    const L = (hex: string | undefined) => rgbToOklch(parseHex(hex!)!).l;
    expect(L(dark['accent-hover'])).toBeGreaterThan(L('#3ccf91'));
    expect(L(light['accent-hover'])).toBeLessThan(L('#3ccf91'));
    expect(dark['text-on-accent']).toBe('#08130e');
    expect(deriveAccentTokens('#1a237e', 'dark')['text-on-accent']).toBe('#ffffff');
    expect(deriveAccentTokens('bogus', 'dark')).toEqual({});
  });

  it('builds CSS with overrides, accent and scale tokens', () => {
    const css = buildThemeCss({ ...base, themeId: 'linen', accent: '#3366ff', fontSize: 18 });
    expect(css).toContain(`--snowdrop-bg-chat: ${LINEN.tokens['bg-chat']};`);
    expect(css).toContain('--snowdrop-accent: #3366ff;');
    // fontSize (px) is the stored setting; font-scale is derived as fontSize / 15.
    expect(css).toContain('--snowdrop-font-scale: 1.2;');
    expect(buildThemeCss({ ...base, themeId: 'high-contrast' })).toContain('0 0 0 2px #ffffff');
  });
});

describe('applyAppearance', () => {
  afterEach(() => {
    clearAppearance(document);
  });

  it('writes ordered style tags and root attributes', () => {
    const late = document.createElement('style');
    late.id = 'late';
    applyAppearance(document, { ...base, customCss: 'body{color:red}', pluginCss: '.x{}' });
    document.head.appendChild(late);
    applyAppearance(document, {
      ...base,
      themeId: 'linen',
      customCss: 'body{color:blue}',
      reducedMotion: 'on',
      saturation: 0.5,
      density: 'compact',
    });

    const ids = [...document.head.querySelectorAll('style')].map((s) => s.id);
    expect(ids.slice(-3)).toEqual([STYLE_IDS.theme, STYLE_IDS.plugins, STYLE_IDS.customCss]);
    expect(document.getElementById(STYLE_IDS.customCss)?.textContent).toBe('body{color:blue}');
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('linen');
    expect(root.getAttribute('data-theme-kind')).toBe('light');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.getAttribute('data-reduced-motion')).toBe('on');
    expect(root.hasAttribute('data-saturation-adjusted')).toBe(true);

    applyAppearance(document, base);
    expect(root.hasAttribute('data-reduced-motion')).toBe(false);
    expect(document.querySelectorAll(`#${STYLE_IDS.theme}`)).toHaveLength(1);
    late.remove();
  });

  // Regression: a theme switch used to unconditionally re-append all three
  // <style> tags (a DOM remove+insert of each, even when nothing had moved
  // them), on every apply. WebKitGTK has been observed to occasionally fail
  // to repaint already-composited content after that kind of redundant
  // detach/reattach of the live `:root` custom-property sheet -- the chat
  // column keeps the previous theme's raster even though getComputedStyle
  // already reports the new values (see engine.ts's applyAppearance comment).
  // A plain switch, with nothing displacing our tags, must not touch the DOM
  // position of any of the three style elements.
  it('does not reposition its style tags when nothing has displaced them', () => {
    applyAppearance(document, base);
    const appendSpy = vi.spyOn(document.head, 'appendChild');

    applyAppearance(document, { ...base, themeId: 'linen' });

    expect(appendSpy).not.toHaveBeenCalled();
    appendSpy.mockRestore();
  });

  it('sets data-shell="tui" only for the TUI shell', () => {
    const root = document.documentElement;
    applyAppearance(document, { ...base, shell: 'tui' });
    expect(root.getAttribute('data-shell')).toBe('tui');
    applyAppearance(document, base);
    expect(root.hasAttribute('data-shell')).toBe(false);
  });

  it('clearAppearance removes data-shell too', () => {
    const root = document.documentElement;
    applyAppearance(document, { ...base, shell: 'tui' });
    clearAppearance(document);
    expect(root.hasAttribute('data-shell')).toBe(false);
  });
});
