/// <reference types="node" />
// @vitest-environment node
//
// Regression test for a production crash: the Tauri build freezes
// Object.prototype (src-tauri/tauri.conf.json: freezePrototype), and the
// `qrcode` package used to assign `exports.toString = ...` at module init,
// which throws under a frozen prototype and blanks the LinkDevice screen.
// `uqr` replaced it (see QrCode.tsx); this spawns a real child process that
// freezes Object.prototype *before* importing the QR package, matching what
// the renderer sees in a Tauri build, and fails loudly if a future
// dependency bump reintroduces the problem.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('QrCode under a frozen Object.prototype', () => {
  it('imports and encodes a realistic link URI without throwing', () => {
    // A link-device URI shaped like the real one: 22-char uuid, ~60-char
    // url-encoded base64 pub_key.
    const uuid = 'a1b2c3d4e5f647a889ab12';
    const pubKey = encodeURIComponent(Buffer.from('k'.repeat(44)).toString('base64'));
    const uri = `sgnl://linkdevice?uuid=${uuid}&pub_key=${pubKey}`;

    const script = `
      Object.freeze(Object.prototype);
      const { encode } = await import('uqr');
      const qr = encode(${JSON.stringify(uri)}, { ecc: 'M', border: 0 });
      if (!Array.isArray(qr.data) || qr.size <= 0) {
        throw new Error('unexpected QR result shape');
      }
    `;

    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
