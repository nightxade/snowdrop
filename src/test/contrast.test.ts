/**
 * WCAG contrast for every built-in theme (PLAN §4.12: ≥ 4.5:1 for text).
 * Base values come from tokens.css itself, so the test can't drift from it.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  accentContext,
  BUILTIN_THEMES,
  buildThemeCss,
  contrastRatio,
  deriveAccentText,
  textSurfaces,
  type Theme,
  type TokenName,
} from '@/core/themes';
import tokensCss from '@/ui/styles/tokens.css?raw';

const base: Record<string, string> = {};
// Only the top-level :root block (reduced-motion overrides follow later).
const rootBlock = tokensCss.slice(0, tokensCss.indexOf('}'));
for (const m of rootBlock.matchAll(/--shrike-([a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
  base[m[1] as string] = (m[2] as string).trim();
}

function tokens(theme: Theme): (name: TokenName) => string {
  return (name) => theme.tokens[name] ?? base[name] ?? '';
}

const HEX = /^#[0-9a-f]{6}$/iu;
const AVATARS = Array.from({ length: 12 }, (_, i) => `avatar-${i + 1}` as TokenName);
/** Opaque surfaces text sits on. */
const SURFACES: TokenName[] = [
  'bg-rail',
  'bg-sidebar',
  'bg-chat',
  'bg-elevated',
  'bg-floating',
  'bg-input',
];

describe.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))('%s contrast', (_name, theme) => {
  const t = tokens(theme);

  it('uses opaque hex values for the tokens under test', () => {
    for (const name of [
      ...SURFACES,
      'text',
      'text-muted',
      'text-faint',
      'accent',
      'danger-strong',
      ...AVATARS,
    ] as TokenName[])
      expect(t(name), name).toMatch(HEX);
  });

  it.each(['text', 'text-muted', 'text-faint'] as TokenName[])(
    '%s ≥ 4.5 on every surface',
    (fg) => {
      for (const bg of SURFACES) {
        expect(contrastRatio(t(fg), t(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('badge and danger button text ≥ 4.5', () => {
    expect(contrastRatio(t('text-on-danger'), t('danger-strong'))).toBeGreaterThanOrEqual(4.5);
  });

  it('accent button text ≥ 4.5', () => {
    expect(contrastRatio(t('text-on-accent'), t('accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('white avatar initials ≥ 4.5 on every hue', () => {
    for (const hue of AVATARS) {
      expect(contrastRatio(t('text-on-avatar'), t(hue)), hue).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Hovered rows, menu items and the selected sidebar/member row: the tints
  // composited over the surfaces they're painted on (P6: profile "(you)",
  // hovered timestamps, accent text in popouts).
  const surfaces = textSurfaces(theme);

  it('covers the hover/selected composites, not just the flat surfaces', () => {
    expect(surfaces.length).toBeGreaterThan(SURFACES.length - 2);
  });

  it.each(['text', 'text-muted', 'text-faint', 'text-link'] as TokenName[])(
    '%s ≥ 4.5 on every hover and selected surface',
    (fg) => {
      for (const bg of surfaces)
        expect(contrastRatio(t(fg), bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  // "Failed to send" / "Not delivered" sit in message rows, which hover but never select.
  it.each(['danger', 'warning'] as TokenName[])('%s ≥ 4.5 on hovered surfaces', (fg) => {
    for (const bg of textSurfaces(theme, { selected: false }))
      expect(contrastRatio(t(fg), bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  const accentTextOf = (accent: string | null) =>
    /--shrike-accent-text: (#[0-9a-f]{6});/u.exec(
      buildThemeCss({
        themeId: theme.id,
        accent,
        density: 'comfortable',
        fontScale: 1,
        zoom: 1,
        saturation: 1,
        reducedMotion: 'system',
        customCss: '',
      }),
    )?.[1] ?? '';

  it('accent-text ≥ 4.5 on its hardest surface (theme accent)', () => {
    const text = accentTextOf(null);
    for (const bg of surfaces)
      expect(contrastRatio(text, bg), `accent-text on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ACCENT_PRESETS.map((p) => [p.label, p.value] as const))(
    'accent-text for the %s preset ≥ 4.5 on every surface',
    (_label, value) => {
      const text = accentTextOf(value);
      expect(text).toBe(deriveAccentText(accentContext(theme, value).accent, surfaces));
      for (const bg of surfaces)
        expect(contrastRatio(text, bg), `${value} as text on ${bg}`).toBeGreaterThanOrEqual(4.5);
    },
  );
});
