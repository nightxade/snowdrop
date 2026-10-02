import { describe, expect, it } from 'vitest';
import { buildThemeCss } from './engine';
import { exportTheme, parseThemeJson, toTheme, validateTheme } from './custom';
import { sanitizeUserCss } from './sanitize';
import { LINEN } from './builtin';

describe('theme import', () => {
  it('accepts known tokens (bare or --shrike- prefixed) and derives an id', () => {
    const result = parseThemeJson(
      JSON.stringify({
        name: 'Sea Glass',
        kind: 'light',
        tokens: { accent: '#2fa08f', '--shrike-bg-chat': '#f4fbfa' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme).toEqual({
      id: 'sea-glass',
      name: 'Sea Glass',
      kind: 'light',
      tokens: { accent: '#2fa08f', 'bg-chat': '#f4fbfa' },
      css: '',
    });
  });

  it('rejects unknown tokens, non-string values and declaration break-outs', () => {
    const result = validateTheme({
      name: 'Bad',
      tokens: {
        accnet: '#fff',
        accent: 3,
        'bg-chat': 'red; } body { display: none',
        text: '/* x */',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'Unknown token "accnet".',
      'Token "accent" must be a string.',
      'Token "bg-chat" has an invalid value.',
      'Token "text" has an invalid value.',
    ]);
  });

  it('rejects bad JSON, missing names, built-in ids and non-object tokens', () => {
    expect(parseThemeJson('{nope')).toEqual({ ok: false, errors: ['The file is not valid JSON.'] });
    expect(validateTheme([]).ok).toBe(false);
    const r = validateTheme({ id: 'dusk', name: '', tokens: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toMatch(/name/u);
      expect(r.errors.join(' ')).toMatch(/built-in/u);
      expect(r.errors.join(' ')).toMatch(/tokens/u);
    }
  });

  it('strips remote @imports from theme CSS with a warning', () => {
    const r = validateTheme({
      name: 'Fonts',
      tokens: {},
      css: "@import url('https://fonts.example.com/x.css');\n:root { color: red; }",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.css).not.toMatch(/@import/u);
    expect(r.warnings[0]).toMatch(/remote @import/u);
  });

  it('round-trips through export and applies through the engine', () => {
    const exported = exportTheme({ ...LINEN, id: 'linen-copy', name: 'Linen copy' });
    const r = parseThemeJson(exported);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const theme = toTheme(r.theme);
    expect(theme.kind).toBe('light');
    const css = buildThemeCss({
      themeId: 'linen-copy',
      accent: null,
      density: 'comfortable',
      fontScale: 1,
      zoom: 1,
      saturation: 1,
      reducedMotion: 'system',
      quickCss: '',
      extraThemes: [theme],
    });
    expect(css).toContain('--shrike-bg-chat: #faf8f4;');
  });

  it('re-validates stored themes (storage is untrusted too)', () => {
    const theme = toTheme({
      id: 'x',
      name: 'X',
      kind: 'dark',
      tokens: { accent: '#fff', bogus: '1', text: 'a;b' },
      css: '',
    });
    expect(theme.tokens).toEqual({ accent: '#fff' });
  });
});

describe('QuickCSS sanitiser', () => {
  it('removes remote @import rules in every syntax and keeps local ones', () => {
    const input = [
      "@import url('https://evil.example/a.css');",
      '@import "http://evil.example/b.css" screen;',
      '@import url(//cdn.example/c.css);',
      "@import 'local.css';",
      ':root { --shrike-accent: #fff; }',
    ].join('\n');
    const out = sanitizeUserCss(input);
    expect(out.removedImports).toEqual([
      'https://evil.example/a.css',
      'http://evil.example/b.css',
      '//cdn.example/c.css',
    ]);
    expect(out.css).not.toMatch(/evil|cdn\.example/u);
    expect(out.css).toContain("@import 'local.css';");
    expect(out.css).toContain('--shrike-accent');
  });

  it('is case-insensitive and reports (but keeps) remote url() references', () => {
    const out = sanitizeUserCss(
      "@IMPORT URL(HTTPS://x.example/y.css);\nbody { background: url('https://img.example/bg.png') }\n/* url(https://ignored.example) */",
    );
    expect(out.removedImports).toHaveLength(1);
    expect(out.remoteUrls).toEqual(['https://img.example/bg.png']);
    expect(out.css).toContain('img.example');
  });
});
