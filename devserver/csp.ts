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

/**
 * The desktop app's policy: the same, plus Tauri's IPC endpoints (`ipc:` on
 * Linux/macOS, `http://ipc.localhost` on Windows). Tauri applies it itself
 * from src-tauri/tauri.conf.json (a test keeps the two equal), adding hashes
 * for its own scripts, so desktop builds get no meta tag.
 */
export const TAURI_CSP = CSP.replace(
  "connect-src 'self'",
  "connect-src 'self' ipc: http://ipc.localhost",
);

/** True while the Tauri CLI runs the build (`beforeBuildCommand`). */
export const isTauriBuild = (): boolean => Boolean(process.env.TAURI_ENV_PLATFORM);

export function contentSecurityPolicy({ desktop = false }: { desktop?: boolean } = {}): Plugin {
  return {
    name: 'snowdrop:csp',
    apply: 'build',
    transformIndexHtml: () =>
      desktop
        ? []
        : [
            {
              tag: 'meta',
              attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
              injectTo: 'head',
            },
          ],
  };
}
