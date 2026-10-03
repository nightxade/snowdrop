/** Theme import drops engine-owned tokens; exporting a built-in carries every resolved value. */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  exportTheme,
  isValidTokenValue,
  parseThemeJson,
  parseTokenBlock,
  resolvedThemeTokens,
  validateTheme,
} from '@/core/themes';
import tokensCss from '@/ui/styles/tokens.css?raw';

describe('engine-owned tokens and built-in export (P6)', () => {
  it('drops engine tokens on import with a warning', () => {
    const r = validateTheme({
      name: 'Overreach',
      tokens: { 'bg-chat': '#101010', 'font-scale': '2', '--shrike-accent-text': '#ff0000' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.tokens).toEqual({ 'bg-chat': '#101010' });
    expect(r.warnings.join(' ')).toMatch(/Ignored "font-scale", "--shrike-accent-text"/u);
  });

  it.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))(
    'exports %s with every resolved token, and the file imports back',
    (_name, theme) => {
      const base = parseTokenBlock(tokensCss);
      const tokens = resolvedThemeTokens(theme, base);
      expect(Object.keys(tokens).length).toBeGreaterThan(40);
      expect(tokens['bg-chat']).toBe(theme.tokens['bg-chat'] ?? base['bg-chat']);
      expect(tokens['accent-text']).toBeUndefined();
      const json = exportTheme({ ...theme, id: `${theme.id}-copy`, tokens });
      const back = parseThemeJson(json);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.theme.tokens['bg-chat']).toBe(tokens['bg-chat']);
    },
  );
});

describe('token values', () => {
  it('reject src() like the other resource functions', () => {
    expect(isValidTokenValue('bg-chat', 'src(https://evil.example/b.png)')).toBe(false);
    expect(isValidTokenValue('font-sans', 'src("x.woff2")')).toBe(false);
  });
});
