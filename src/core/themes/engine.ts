/**
 * Applies appearance to a document: theme tokens, accent override, plugin CSS
 * and Custom CSS, each in its own <style> tag, in that cascade order.
 *
 * Takes a Document-like parameter (not the global) so it's testable and could
 * target an iframe preview. Tags are moved to the end of <head> on each apply
 * so later-loaded stylesheets can't silently outrank user CSS.
 */
import type { ReducedMotion, Density } from '@/core/stores';
import { findTheme, type Theme } from './builtin';
import { adjustLightness, contrastRatio, parseHex, withAlpha } from './color';
import { DUSK_BASE } from './builtin';
import { sanitizeUserCss } from './sanitize';
import { cssVar, type TokenName, type TokenOverrides } from './tokens';

export type ThemeDocument = Pick<
  Document,
  'getElementById' | 'createElement' | 'head' | 'documentElement'
>;

export interface AppearanceInput {
  themeId: string;
  accent: string | null;
  density: Density;
  fontScale: number;
  zoom: number;
  saturation: number;
  reducedMotion: ReducedMotion;
  customCss: string;
  pluginCss?: string;
  /** Additional themes (user-imported, plugins). */
  extraThemes?: readonly Theme[];
  /** Thicker focus outline (data-focus="strong"). */
  strongFocus?: boolean;
  /** Larger hit targets (data-targets="large"). */
  largeTargets?: boolean;
}

export const STYLE_IDS = {
  theme: 'shrike-theme',
  plugins: 'shrike-plugins',
  customCss: 'shrike-custom-css',
} as const;

/**
 * Derives the full accent family from one colour. Hover moves away from the
 * background (lighter on dark themes, darker on light ones), active the
 * other way, and text-on-accent picks whichever of near-black/white reads better.
 */
export function deriveAccentTokens(accent: string, kind: Theme['kind']): TokenOverrides {
  if (!parseHex(accent)) return {};
  const dir = kind === 'dark' ? 1 : -1;
  const onDark = '#1a0f0b';
  const onLight = '#ffffff';
  const textOnAccent =
    contrastRatio(accent, onDark) >= contrastRatio(accent, onLight) ? onDark : onLight;
  return {
    accent,
    'accent-hover': adjustLightness(accent, 0.05 * dir),
    'accent-active': adjustLightness(accent, -0.06 * dir),
    'accent-soft': withAlpha(accent, 0.16),
    'text-on-accent': textOnAccent,
    'mention-bg': withAlpha(accent, 0.1),
    'mention-bar': accent,
    'mention-pill-bg': withAlpha(accent, 0.22),
    'focus-ring': accent,
  };
}

/**
 * The accent as a text colour: moves OKLCH lightness away from the
 * background (lighter on dark, darker on light) until it reaches `min`
 * contrast on it. Returns the accent unchanged when it already does, or when
 * either colour isn't hex (custom themes using rgb()).
 */
export function deriveAccentText(accent: string, background: string, min = 4.5): string {
  if (!parseHex(accent) || !parseHex(background)) return accent;
  if (contrastRatio(accent, background) >= min) return accent;
  const lighter = contrastRatio('#ffffff', background) >= contrastRatio('#000000', background);
  for (let step = 1; step <= 60; step++) {
    const best = adjustLightness(accent, (lighter ? 0.01 : -0.01) * step);
    if (contrastRatio(best, background) >= min) return best;
  }
  return lighter ? '#ffffff' : '#000000';
}

/** The effective accent and chat background of a theme (+ override). */
export function accentContext(theme: Theme, accentOverride: string | null) {
  const accent = accentOverride ?? theme.tokens.accent ?? DUSK_BASE.accent;
  const background = theme.tokens['bg-chat'] ?? DUSK_BASE['bg-chat'];
  return { accent, background };
}

function tokenBlock(tokens: TokenOverrides): string {
  const lines = (Object.entries(tokens) as [TokenName, string][])
    .map(([name, value]) => `  ${cssVar(name)}: ${value};`)
    .join('\n');
  return lines ? `:root {\n${lines}\n}` : '';
}

/** Pure: the CSS text for the theme <style> tag. */
export function buildThemeCss(input: AppearanceInput): string {
  const theme = findTheme(input.themeId, input.extraThemes);
  const { accent, background } = accentContext(theme, input.accent);
  const tokens: TokenOverrides = {
    ...theme.tokens,
    ...(input.accent ? deriveAccentTokens(input.accent, theme.kind) : {}),
    'accent-text': deriveAccentText(accent, background),
    'font-scale': String(input.fontScale),
    zoom: String(input.zoom),
    saturation: String(input.saturation),
  };
  return [tokenBlock(tokens), theme.css ?? ''].filter(Boolean).join('\n');
}

function ensureStyle(doc: ThemeDocument, id: string): HTMLElement {
  const existing = doc.getElementById(id);
  if (existing?.tagName === 'STYLE') return existing;
  // Something else squatting on our id: replace it rather than write CSS into it.
  existing?.remove();
  const el = doc.createElement('style');
  el.id = id;
  return el;
}

export function applyAppearance(doc: ThemeDocument, input: AppearanceInput): void {
  const theme = findTheme(input.themeId, input.extraThemes);
  const blocks: [string, string][] = [
    [STYLE_IDS.theme, buildThemeCss(input)],
    [STYLE_IDS.plugins, input.pluginCss ?? ''],
    // Remote @imports are stripped here, whatever the caller did (privacy).
    [STYLE_IDS.customCss, sanitizeUserCss(input.customCss).css],
  ];
  for (const [id, css] of blocks) {
    const el = ensureStyle(doc, id);
    if (el.textContent !== css) el.textContent = css;
    // appendChild moves an existing node, keeping our three tags last and ordered.
    doc.head.appendChild(el);
  }

  const root = doc.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-theme-kind', theme.kind);
  root.style.colorScheme = theme.kind;
  root.setAttribute('data-density', input.density);
  if (input.reducedMotion === 'system') root.removeAttribute('data-reduced-motion');
  else root.setAttribute('data-reduced-motion', input.reducedMotion);
  if (input.saturation < 1) root.setAttribute('data-saturation-adjusted', '');
  else root.removeAttribute('data-saturation-adjusted');
  if (input.strongFocus) root.setAttribute('data-focus', 'strong');
  else root.removeAttribute('data-focus');
  if (input.largeTargets) root.setAttribute('data-targets', 'large');
  else root.removeAttribute('data-targets');
}

/** Removes everything applyAppearance added (tests, theme previews). */
export function clearAppearance(doc: ThemeDocument): void {
  for (const id of Object.values(STYLE_IDS)) doc.getElementById(id)?.remove();
  for (const attr of [
    'data-theme',
    'data-theme-kind',
    'data-density',
    'data-reduced-motion',
    'data-saturation-adjusted',
    'data-focus',
    'data-targets',
  ]) {
    doc.documentElement.removeAttribute(attr);
  }
}
