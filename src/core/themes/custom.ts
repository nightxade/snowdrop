/**
 * Import/export of user themes as JSON: `{ id, name, kind?, tokens, css? }`.
 *
 * Imported files are untrusted. Only known token names with plain string
 * values are accepted, values can't break out of their declaration, and the
 * CSS goes through the same remote-reference guard as Custom CSS.
 */
import type { CustomThemeData } from '@/core/stores';
import type { Theme } from './builtin';
import { BUILTIN_THEMES } from './builtin';
import { removedSummary, sanitizeUserCss } from './sanitize';
import { isValidTokenValue } from './tokenValues';
import { isTokenName, TOKEN_NAMES, type TokenName, type TokenOverrides } from './tokens';

/**
 * Tokens the engine always sets itself, from settings (text size, zoom,
 * saturation) or derived for contrast (accent as text). A theme's value for
 * them would be silently overridden, so imports drop them with a warning and
 * exports leave them out.
 */
export const ENGINE_TOKENS: readonly TokenName[] = [
  'accent-text',
  'font-scale',
  'zoom',
  'saturation',
];

export type ThemeImportResult =
  { ok: true; theme: CustomThemeData; warnings: string[] } | { ok: false; errors: string[] };

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const MAX_CSS = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
}

export function parseThemeJson(text: string): ThemeImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] };
  }
  return validateTheme(data);
}

export function validateTheme(data: unknown): ThemeImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(data)) return { ok: false, errors: ['A theme must be a JSON object.'] };

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) errors.push('The theme needs a "name".');
  if (name.length > 40) errors.push('"name" must be at most 40 characters.');

  let id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) id = slug(name);
  // A missing name already explains a missing id.
  if (name && !ID.test(id)) errors.push('"id" may only use lowercase letters, digits and dashes.');
  if (BUILTIN_THEMES.some((t) => t.id === id))
    errors.push(`"${id}" is a built-in theme id; pick another id.`);

  if (data.kind !== undefined && data.kind !== 'dark' && data.kind !== 'light')
    errors.push('"kind" must be "dark" or "light".');

  const tokens: Record<string, string> = {};
  const ignored: string[] = [];
  if (!isObject(data.tokens)) {
    errors.push('"tokens" must be an object of token names to CSS values.');
  } else {
    for (const [key, value] of Object.entries(data.tokens)) {
      // Accept both "accent" and "--shrike-accent".
      const nameOnly = key.startsWith('--shrike-') ? key.slice('--shrike-'.length) : key;
      if (!isTokenName(nameOnly)) {
        errors.push(`Unknown token "${key}".`);
        continue;
      }
      if (typeof value !== 'string') {
        errors.push(`Token "${key}" must be a string.`);
        continue;
      }
      if (!isValidTokenValue(nameOnly, value)) {
        errors.push(`Token "${key}" has an invalid value.`);
        continue;
      }
      if (ENGINE_TOKENS.includes(nameOnly)) {
        ignored.push(`"${key}"`);
        continue;
      }
      tokens[nameOnly] = value.trim();
    }
  }
  if (ignored.length > 0)
    warnings.push(
      `Ignored ${ignored.join(', ')}: Shrike sets ${ignored.length === 1 ? 'this' : 'these'} itself (text size, zoom and saturation come from your settings; accent text is derived for contrast).`,
    );

  let css = '';
  if (data.css !== undefined) {
    if (typeof data.css !== 'string') errors.push('"css" must be a string.');
    else if (data.css.length > MAX_CSS) errors.push('"css" is too large (100 kB max).');
    else {
      const clean = sanitizeUserCss(data.css);
      css = clean.css;
      const summary = removedSummary(clean.removed);
      if (summary) warnings.push(`${summary} from the theme CSS (privacy).`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    theme: { id, name, kind: data.kind === 'light' ? 'light' : 'dark', tokens, css },
    warnings,
  };
}

/** Stored custom theme → engine theme (stored data is re-checked: storage is untrusted too). */
export function toTheme(data: CustomThemeData): Theme {
  const tokens: TokenOverrides = {};
  for (const [key, value] of Object.entries(data.tokens)) {
    if (isTokenName(key) && isValidTokenValue(key, value)) tokens[key] = value;
  }
  const pick = (k: keyof TokenOverrides, fallback: string) => tokens[k] ?? fallback;
  const light = data.kind === 'light';
  return {
    id: data.id,
    name: data.name,
    description: 'Imported theme',
    kind: data.kind,
    tokens,
    css: sanitizeUserCss(data.css).css,
    preview: [
      pick('bg-rail', light ? '#e4ded5' : '#101114'),
      pick('bg-chat', light ? '#faf8f4' : '#1b1d22'),
      pick('text', light ? '#26221f' : '#e6e8eb'),
      pick('accent', light ? '#a84f2c' : '#d4744a'),
    ],
  };
}

/** Reads `--shrike-*: value;` declarations from the first rule of a stylesheet (tokens.css). */
export function parseTokenBlock(css: string): Partial<Record<TokenName, string>> {
  const block = css.slice(0, css.indexOf('}'));
  const out: Partial<Record<TokenName, string>> = {};
  for (const m of block.matchAll(/--shrike-([a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    const name = m[1] as string;
    if (isTokenName(name)) out[name] = (m[2] as string).trim();
  }
  return out;
}

/**
 * Every token value a theme ends up with: the base sheet's values with the
 * theme's overrides on top, minus the engine's own tokens and anything an
 * import wouldn't accept. Exporting a built-in (whose overrides are sparse,
 * or empty for Dusk) uses this so the file describes the theme completely.
 */
export function resolvedThemeTokens(
  theme: Pick<Theme, 'tokens'>,
  base: Partial<Record<TokenName, string>>,
): TokenOverrides {
  const out: TokenOverrides = {};
  for (const name of TOKEN_NAMES) {
    if (ENGINE_TOKENS.includes(name)) continue;
    const value = theme.tokens[name] ?? base[name];
    if (value !== undefined && isValidTokenValue(name, value)) out[name] = value;
  }
  return out;
}

/** Serialises a theme in the import format. */
export function exportTheme(theme: Theme | CustomThemeData): string {
  return `${JSON.stringify(
    {
      id: theme.id,
      name: theme.name,
      kind: theme.kind,
      tokens: theme.tokens,
      ...(theme.css ? { css: theme.css } : {}),
    },
    null,
    2,
  )}\n`;
}
