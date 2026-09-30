/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // Deterministic day grouping and clock formatting.
    env: { TZ: 'UTC' },
    // Let ?raw imports of our token sheet through (vitest blanks CSS by default).
    css: { include: [/tokens\.css/] },
  },
});
