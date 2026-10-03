// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP, TAURI_CSP } from './csp';

describe('Content-Security-Policy', () => {
  it('the desktop app enforces the browser policy plus Tauri IPC, nothing more', () => {
    const config = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { app: { security: { csp: string; devCsp: unknown } } };
    expect(config.app.security.csp).toBe(TAURI_CSP);
    expect(TAURI_CSP.replace(' ipc: http://ipc.localhost', '')).toBe(CSP);
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("object-src 'none'");
  });
});
