/**
 * Privacy guard for user-supplied CSS (Custom CSS, imported themes).
 *
 * Any CSS fetch to a third party is a beacon: it tells that server when you
 * use Snowdrop, and attribute selectors or `unicode-range` can even leak what
 * is on screen. So every statement or declaration that references a resource
 * (`@import`, `url(`, `src(`, `image-set(`, `image(`, `cross-fade(`,
 * `element(`) is removed unless all its targets are inline (`data:` /
 * `blob:`). A target that is a `var()` counts as remote: the custom property
 * could hold anything.
 *
 * Decisions are made on a *normalised* copy of each statement (comments
 * stripped, CSS escapes decoded), so `@\69mport`, `https\3a //`,
 * `@import/**\/url()` and friends can't sneak past; the statements that
 * survive are emitted as written. The production Content-Security-Policy
 * meta tag (`devserver/csp.ts`, added to built pages) is the second line of
 * defence.
 */

export interface SanitizedCss {
  css: string;
  /** Normalised snippets of what was removed (for "Removed N remote references"). */
  removed: string[];
}

const HEX = /^[0-9a-f]$/iu;

/** Decodes CSS escapes (`\69`, `\3a `, `\:`, escaped newlines). */
export function cssUnescape(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = input.charAt(i + 1);
    if (next === '') break;
    if (next === '\n') {
      i++;
      continue;
    }
    if (HEX.test(next)) {
      let hex = '';
      let j = i + 1;
      while (j < input.length && hex.length < 6 && HEX.test(input.charAt(j)))
        hex += input.charAt(j++);
      // One whitespace after a hex escape belongs to the escape.
      if (/\s/u.test(input.charAt(j))) j++;
      const code = parseInt(hex, 16);
      out += code === 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code);
      i = j - 1;
      continue;
    }
    out += next;
    i++;
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?(\*\/|$)/gu, '');

/** Lower-cased, comment-free, unescaped text of one statement. */
export function normaliseCss(s: string): string {
  return cssUnescape(stripComments(s)).toLowerCase();
}

const INLINE = /^(data|blob):/u;
const RESOURCE = /@import|url\(|(?<![\w-])src\(|image-set\(|image\(|cross-fade\(|element\(/u;

/** Resource targets referenced by a normalised statement (null = unparseable). */
function targetsOf(normalised: string): string[] | null {
  const targets: string[] = [];
  for (const m of normalised.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gu))
    targets.push(m[2] ?? '');
  // Bare strings inside image-set()/src()/@import also fetch.
  for (const m of normalised.matchAll(/(?:image-set\(|(?<![\w-])src\(|@import)([^;{}]*)/gu)) {
    const args = m[1] ?? '';
    for (const s of args.matchAll(/(['"])(.*?)\1/gu)) targets.push(s[2] ?? '');
    // `src(var(--u))`, `image-set(var(--u) 1x)`: the property's value is unknown.
    if (/var\(/u.test(args)) targets.push('var(');
  }
  if (targets.length === 0) return null;
  return targets.map((t) => t.trim());
}

function isSafe(normalised: string): boolean {
  if (!RESOURCE.test(normalised)) return true;
  const targets = targetsOf(normalised);
  return targets !== null && targets.every((t) => INLINE.test(t));
}

interface Chunk {
  text: string;
  /** What ended the chunk: '{' (a prelude), ';', '}' or '' (end of input). */
  end: '{' | ';' | '}' | '';
}

/** Splits CSS at `{`, `;` and `}` outside strings, comments and escapes. */
function chunks(css: string): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  let quote: string | null = null;
  // `url(data:image/png;base64,…)` contains a `;` that doesn't end anything.
  let parens = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote || ch === '\n') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '/' && css.charAt(i + 1) === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 1;
      continue;
    }
    if (ch === '(') parens++;
    else if (ch === ')') parens = Math.max(0, parens - 1);
    else if (ch === ';' && parens > 0) continue;
    if (ch === '{' || ch === ';' || ch === '}') {
      parens = 0;
      out.push({ text: css.slice(start, i + 1), end: ch });
      start = i + 1;
    }
  }
  if (start < css.length) out.push({ text: css.slice(start), end: '' });
  return out;
}

export function sanitizeUserCss(input: string): SanitizedCss {
  const removed: string[] = [];
  let css = '';
  // Depth of a removed block being skipped (its prelude referenced a resource).
  let skipping = 0;
  for (const chunk of chunks(input)) {
    if (skipping > 0) {
      if (chunk.end === '{') skipping++;
      else if (chunk.end === '}') skipping--;
      continue;
    }
    const norm = normaliseCss(chunk.text);
    if (isSafe(norm)) {
      css += chunk.text;
      continue;
    }
    removed.push(norm.replace(/\s+/gu, ' ').trim().slice(0, 120));
    if (chunk.end === '{') skipping = 1;
    // Keep a closing brace so the surrounding block stays balanced.
    else if (chunk.end === '}') css += '}';
  }
  return { css, removed };
}

/** Plain-language summary for the UI, or null when nothing was removed. */
export function removedSummary(removed: readonly string[]): string | null {
  if (removed.length === 0) return null;
  return `Removed ${removed.length} remote reference${removed.length === 1 ? '' : 's'}`;
}
