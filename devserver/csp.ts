import type { Plugin } from 'vite';

/**
 * Production Content-Security-Policy (build only: Vite's dev server needs
 * inline scripts for HMR). Everything is same-origin, including signal-cli
 * through the `/signal-cli` proxy path, so the policy can forbid every
 * third-party fetch. This is the backstop behind the CSS sanitiser: user CSS
 * and themes can't beacon out even if something slips through.
 */
export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'shrike:csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head',
      },
    ],
  };
}
