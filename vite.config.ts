/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * Same-origin path to the signal-cli HTTP daemon. The browser can't call the
 * daemon directly: it sends no CORS headers and only accepts requests whose
 * Host header matches its bind address (hence `changeOrigin`). The target is
 * HEARTH_SIGNAL_CLI_URL (shell or .env*), default http://127.0.0.1:8080.
 */
function signalCliProxy(target: string): Record<string, ProxyOptions> {
  return {
    '/signal-cli': {
      target,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/signal-cli/u, ''),
      // The event stream is long-lived: never time it out at the proxy.
      timeout: 0,
      proxyTimeout: 0,
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HEARTH_');
  const proxy = signalCliProxy(env.HEARTH_SIGNAL_CLI_URL ?? 'http://127.0.0.1:8080');
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: { proxy },
    preview: { proxy },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
      // Deterministic day grouping and clock formatting.
      env: { TZ: 'UTC' },
      // Let ?raw imports of our token sheet through (vitest blanks CSS by default).
      css: { include: [/tokens\.css/] },
    },
  };
});
