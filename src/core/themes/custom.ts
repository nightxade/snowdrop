/**
 * Import/export of user themes as JSON: `{ id, name, kind?, tokens, css? }`.
 *
 * Imported files are untrusted. Only known token names with plain string
 * values are accepted, values can't break out of their declaration, and the
 * CSS goes through the same remote-import guard as QuickCSS.
 */
import type { CustomThemeData } from '@/core/stores';
import type { Theme } from './builtin';
import { BUILTIN_THEMES } from './builtin';
import { sanitizeUserCss } from './sanitize';
import { isTokenName, type TokenOverrides } from './tokens';

export type ThemeImportResult =
  { ok: true; theme: CustomThemeData; warnings: string[] } | { ok: false; errors: string[] };

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const MAX_CSS = 100_000;
/** A value may not end its declaration or open/close a block. */
const UNSAFE_VALUE = /[;{}<>]|\/\*|\*\//u;

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
  if (!name) errors.push('"name" must be a non-empty string.');
  if (name.length > 40) errors.push('"name" must be at most 40 characters.');

  let id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) id = slug(name);
  if (!ID.test(id)) errors.push('"id" may only use lowercase letters, digits and dashes.');
  if (BUILTIN_THEMES.some((t) => t.id === id))
    errors.push(`"${id}" is a built-in theme id; pick another id.`);

  if (data.kind !== undefined && data.kind !== 'dark' && data.kind !== 'light')
    errors.push('"kind" must be "dark" or "light".');

  const tokens: Record<string, string> = {};
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
      if (!value.trim() || UNSAFE_VALUE.test(value)) {
        errors.push(`Token "${key}" has an invalid value.`);
        continue;
      }
      tokens[nameOnly] = value.trim();
    }
  }

  let css = '';
  if (data.css !== undefined) {
    if (typeof data.css !== 'string') errors.push('"css" must be a string.');
    else if (data.css.length > MAX_CSS) errors.push('"css" is too large (100 kB max).');
    else {
      const clean = sanitizeUserCss(data.css);
      css = clean.css;
      if (clean.removedImports.length > 0)
        warnings.push(
          `Removed ${clean.removedImports.length} remote @import${clean.removedImports.length === 1 ? '' : 's'} (privacy).`,
        );
      if (clean.remoteUrls.length > 0)
        warnings.push('The theme CSS loads files from the internet (url(...)).');
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
    if (isTokenName(key) && !UNSAFE_VALUE.test(value)) tokens[key] = value;
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
