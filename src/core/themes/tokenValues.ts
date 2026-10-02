/**
 * What a theme token may be set to. Imported themes are untrusted, so each
 * token kind has an allowlist: colours must parse as colours, sizes as
 * lengths, and so on. Nothing may contain an escape, a resource reference or
 * an at-rule (those are how CSS fetches remote content), and nothing may end
 * its declaration early.
 */
import type { TokenName } from './tokens';

export type TokenKind =
  'color' | 'length' | 'number' | 'font-family' | 'shadow' | 'easing' | 'duration';

export function tokenKind(name: TokenName): TokenKind {
  if (/^(space-|radius-)|-(width|height|size)$|^font-size-|^tracking-/u.test(name)) return 'length';
  if (/^(font-scale|saturation|zoom|line-height-|font-weight-)/u.test(name)) return 'number';
  if (name.startsWith('font-')) return 'font-family';
  if (name.startsWith('shadow-')) return 'shadow';
  if (name === 'ease') return 'easing';
  if (name.startsWith('duration-')) return 'duration';
  return 'color';
}

const PROPERTY: Record<TokenKind, string> = {
  color: 'color',
  length: 'width',
  number: 'opacity',
  'font-family': 'font-family',
  shadow: 'box-shadow',
  easing: 'transition-timing-function',
  duration: 'transition-duration',
};

/** Hard bans whatever the kind: escapes, resources, at-rules, declaration break-outs. */
const FORBIDDEN = /[\\;{}<>@]|\/\*|\*\/|url\(|image-set\(|image\(|cross-fade\(|element\(/iu;

// Fallbacks where CSS.supports is missing (tests, old engines). Deliberately narrow.
const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const COLOR_FN = String.raw`(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\([^()]*(?:\([^()]*\)[^()]*)*\)`;
const FALLBACK: Record<TokenKind, RegExp> = {
  color: new RegExp(
    String.raw`^(?:#[0-9a-f]{3,8}|[a-z]+|${COLOR_FN}|var\(--shrike-[a-z0-9-]+\))$`,
    'iu',
  ),
  length: new RegExp(String.raw`^(?:0|${NUM}(?:px|rem|em|%|vh|vw|ch)|calc\([^;{}]*\))$`, 'iu'),
  number: new RegExp(`^${NUM}$`, 'u'),
  'font-family': /^[\w\s"',.-]+$/u,
  shadow: /^[\w\s#().,%-]+$/u,
  easing: /^(?:ease(?:-in|-out|-in-out)?|linear|cubic-bezier\([\d\s.,-]+\)|steps\([\w\s,]+\))$/u,
  duration: new RegExp(`^${NUM}m?s$`, 'u'),
};

type Supports = (property: string, value: string) => boolean;

function nativeSupports(): Supports | null {
  const css = (globalThis as { CSS?: { supports?: Supports } }).CSS;
  return typeof css?.supports === 'function' ? (p, v) => css.supports?.(p, v) ?? false : null;
}

/** Is `value` acceptable for token `name`? `supports` is injectable for tests. */
export function isValidTokenValue(
  name: TokenName,
  value: string,
  supports: Supports | null = nativeSupports(),
): boolean {
  const v = value.trim();
  if (!v || v.length > 200 || FORBIDDEN.test(v)) return false;
  const kind = tokenKind(name);
  return supports ? supports(PROPERTY[kind], v) : FALLBACK[kind].test(v);
}
