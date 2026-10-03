/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Connect, type Plugin, type ProxyOptions } from 'vite';
import { contentSecurityPolicy, isTauriBuild } from './devserver/csp.ts';
import { emojibaseAssets } from './devserver/emojibase.ts';
import { thirdPartyNotices } from './devserver/notices.ts';
import { checkSignalCliRequest } from './devserver/signalCliGuard.ts';

const PROXY_PATH = '/signal-cli';

/**
 * Same-origin path to the signal-cli HTTP daemon. The browser can't call the
 * daemon directly: it sends no CORS headers and only accepts requests whose
 * Host header matches its bind address (hence `changeOrigin`). The target is
 * SNOWDROP_SIGNAL_CLI_URL (shell or .env*), default http://127.0.0.1:8080.
 */
function signalCliProxy(target: string): Record<string, ProxyOptions> {
  return {
    [PROXY_PATH]: {
      target,
      changeOrigin: true,
      rewrite: (path) => path.slice(PROXY_PATH.length) || '/',
      // The event stream is long-lived: never time it out at the proxy.
      timeout: 0,
      proxyTimeout: 0,
    },
  };
}

/**
 * Rejects proxy requests that don't come from the app itself (see
 * devserver/signalCliGuard.ts). Plugin middlewares added in
 * configureServer/configurePreviewServer run *before* Vite's proxy.
 */
function signalCliGuard(): Plugin {
  const guard: Connect.NextHandleFunction = (req, res, next) => {
    const verdict = checkSignalCliRequest(req);
    if (verdict.ok) {
      next();
      return;
    }
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Forbidden: ${verdict.reason}\n`);
  };
  return {
    name: 'snowdrop:signal-cli-guard',
    configureServer(server) {
      server.middlewares.use(PROXY_PATH, guard);
    },
    configurePreviewServer(server) {
      server.middlewares.use(PROXY_PATH, guard);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'SNOWDROP_');
  const proxy = signalCliProxy(env.SNOWDROP_SIGNAL_CLI_URL ?? 'http://127.0.0.1:8080');
  // `npm run tauri:build` runs this build with TAURI_ENV_* set (docs/DESKTOP.md).
  const desktop = isTauriBuild();
  return {
    plugins: [
      signalCliGuard(),
      emojibaseAssets(),
      contentSecurityPolicy({ desktop }),
      thirdPartyNotices({ desktop }),
      react(),
    ],
    // Tauri's CLI prints its own output in the same terminal.
    clearScreen: false,
    // WebKitGTK (the Linux webview) is Safari-class; the browser build keeps Vite's defaults.
    ...(desktop ? { build: { target: ['es2022', 'safari16'] } } : {}),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // No CORS: nothing but the app's own origin may talk to the dev server.
    // The Rust side rebuilds itself; its target directory must not trigger reloads.
    server: { proxy, cors: false, watch: { ignored: ['**/src-tauri/**'] } },
    preview: { proxy, cors: false },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.{ts,tsx}', 'devserver/**/*.test.ts'],
      restoreMocks: true,
      // Deterministic day grouping and clock formatting.
      env: { TZ: 'UTC' },
      // Let ?raw imports of our token sheet through (vitest blanks CSS by default).
      css: { include: [/tokens\.css/] },
    },
  };
});
