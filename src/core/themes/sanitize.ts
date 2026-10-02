/**
 * Privacy guard for user-supplied CSS (QuickCSS, imported themes).
 *
 * A remote `@import` makes the app fetch a stylesheet from a third party on
 * every launch, which leaks that you use Shrike (and when) to that server.
 * We remove those rules before injecting; local/relative imports are kept.
 * Remote `url()` references (fonts, images) leak the same way, but they're a
 * common deliberate choice, so they are only reported.
 */

export interface SanitizedCss {
  css: string;
  /** The remote `@import` targets that were removed. */
  removedImports: string[];
  /** Remote `url(...)` targets left in place (shown as a warning). */
  remoteUrls: string[];
}

const IMPORT_RULE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;?/giu;
const URL_REF = /url\(\s*(['"]?)([^'")]+)\1\s*\)/giu;
const COMMENT = /\/\*[\s\S]*?\*\//gu;

/** http(s), protocol-relative, or any other scheme with an authority (ftp://…). */
export function isRemoteUrl(target: string): boolean {
  const t = target.trim().toLowerCase();
  return t.startsWith('//') || /^[a-z][a-z0-9+.-]*:\/\//u.test(t);
}

export function sanitizeUserCss(input: string): SanitizedCss {
  const removedImports: string[] = [];
  const css = input.replace(IMPORT_RULE, (rule: string, _q: string, target: string) => {
    if (!isRemoteUrl(target)) return rule;
    removedImports.push(target);
    // Dropped outright (no marker comment: the rule may itself sit inside a comment).
    return '';
  });
  const remoteUrls: string[] = [];
  // Commented-out examples are inert, so they don't warn.
  for (const m of css.replace(COMMENT, '').matchAll(URL_REF)) {
    const target = m[2] ?? '';
    if (isRemoteUrl(target) && !remoteUrls.includes(target)) remoteUrls.push(target);
  }
  return { css, removedImports, remoteUrls };
}
