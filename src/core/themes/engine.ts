/**
 * Applies appearance to a document: theme tokens, accent override, plugin CSS
 * and Custom CSS, each in its own <style> tag, in that cascade order.
 *
 * Takes a Document-like parameter (not the global) so it's testable and could
 * target an iframe preview. Tags are moved to the end of <head> on each apply
 * so later-loaded stylesheets can't silently outrank user CSS.
 */
import type { ReducedMotion, Density, Shell } from '@/core/stores';
import { findTheme, type Theme } from './builtin';
import { adjustLightness, compositeOver, contrastRatio, parseHex, withAlpha } from './color';
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
  /** 'tui' sets `data-shell="tui"` on the document element. */
  shell: Shell;
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
  theme: 'snowdrop-theme',
  plugins: 'snowdrop-plugins',
  customCss: 'snowdrop-custom-css',
} as const;

/**
 * Derives the full accent family from one colour. Hover moves away from the
 * background (lighter on dark themes, darker on light ones), active the
 * other way, and text-on-accent picks whichever of near-black/white reads better.
 */
export function deriveAccentTokens(accent: string, kind: Theme['kind']): TokenOverrides {
  if (!parseHex(accent)) return {};
  const dir = kind === 'dark' ? 1 : -1;
  const onDark = '#08130e';
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
 * backgrounds (lighter on dark, darker on light) until it reaches `min`
 * contrast on every one of them, so the hardest surface decides. Returns the
 * accent unchanged when it already does; non-hex colours (custom themes
 * using rgb()) are ignored, and with none left the accent is returned as is.
 */
export function deriveAccentText(
  accent: string,
  backgrounds: string | readonly string[],
  min = 4.5,
): string {
  const list = (typeof backgrounds === 'string' ? [backgrounds] : backgrounds).filter(
    (b) => parseHex(b) !== null,
  );
  if (!parseHex(accent) || list.length === 0) return accent;
  const worst = (c: string) => Math.min(...list.map((b) => contrastRatio(c, b)));
  if (worst(accent) >= min) return accent;
  const first = list[0] as string;
  const lighter = contrastRatio('#ffffff', first) >= contrastRatio('#000000', first);
  for (let step = 1; step <= 60; step++) {
    const best = adjustLightness(accent, (lighter ? 0.01 : -0.01) * step);
    if (worst(best) >= min) return best;
  }
  return lighter ? '#ffffff' : '#000000';
}

type SurfaceToken = 'bg-chat' | 'bg-sidebar' | 'bg-elevated' | 'bg-floating';
const SURFACE_TOKENS: readonly SurfaceToken[] = [
  'bg-chat',
  'bg-sidebar',
  'bg-elevated',
  'bg-floating',
];

/**
 * The opaque colours text (and accent-coloured text) actually sits on in a
 * theme: the four text surfaces, the hover tint painted over each of them
 * (hovered message rows, sidebar rows, menu items, popout rows), and the
 * selected tint over the chat and sidebar (the open conversation's row, the
 * member whose profile is open). Values that aren't hex/rgba are skipped.
 */
export function textSurfaces(theme: Theme, { selected = true } = {}): string[] {
  const token = (name: keyof typeof DUSK_BASE) => theme.tokens[name] ?? DUSK_BASE[name];
  const out = new Set<string>();
  for (const name of SURFACE_TOKENS) {
    const base = token(name);
    if (!parseHex(base)) continue;
    out.add(base.toLowerCase());
    const tints =
      selected && (name === 'bg-chat' || name === 'bg-sidebar')
        ? (['bg-hover', 'bg-selected'] as const)
        : (['bg-hover'] as const);
    for (const tint of tints.map(token)) {
      const mixed = compositeOver(tint, base);
      if (mixed) out.add(mixed);
    }
  }
  return [...out];
}

/** The effective accent, chat background and text surfaces of a theme (+ override). */
export function accentContext(theme: Theme, accentOverride: string | null) {
  const accent = accentOverride ?? theme.tokens.accent ?? DUSK_BASE.accent;
  const background = theme.tokens['bg-chat'] ?? DUSK_BASE['bg-chat'];
  return { accent, background, surfaces: textSurfaces(theme) };
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
  const { accent, surfaces } = accentContext(theme, input.accent);
  const tokens: TokenOverrides = {
    ...theme.tokens,
    ...(input.accent ? deriveAccentTokens(input.accent, theme.kind) : {}),
    'accent-text': deriveAccentText(accent, surfaces),
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
  const elements = blocks.map(([id, css]) => {
    const el = ensureStyle(doc, id);
    if (el.textContent !== css) el.textContent = css;
    return el;
  });
  // Keep our three tags last and ordered -- but only actually move them (a
  // DOM remove+insert of each <style> node, even to reposition at the same
  // spot) when something has displaced them, e.g. a later stylesheet got
  // inserted after ours. On a plain theme switch the order never changes, so
  // this is normally a no-op.
  //
  // WebKitGTK note: re-appending the live `:root` custom-property sheet on
  // every apply (as this used to do unconditionally) detaches and reattaches
  // it on every theme switch. We observed (rarely, timing-dependent) the chat
  // column keeping the previous theme's paint after such a switch even though
  // computed styles were already correct; avoiding the redundant churn is
  // our best-evidence mitigation.
  const tail = Array.from(doc.head.children).slice(-elements.length);
  const inPlace = tail.length === elements.length && tail.every((node, i) => node === elements[i]);
  if (!inPlace) {
    for (const el of elements) doc.head.appendChild(el);
  }

  const root = doc.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-theme-kind', theme.kind);
  root.style.colorScheme = theme.kind;
  root.setAttribute('data-density', input.density);
  if (input.shell === 'tui') root.setAttribute('data-shell', 'tui');
  else root.removeAttribute('data-shell');
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
    'data-shell',
    'data-reduced-motion',
    'data-saturation-adjusted',
    'data-focus',
    'data-targets',
  ]) {
    doc.documentElement.removeAttribute(attr);
  }
}
