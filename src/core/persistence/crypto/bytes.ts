/**
 * Byte/text/base64 plumbing shared by the cipher implementations and the
 * encrypted stores. `atob`/`btoa` are available as globals in browsers, the
 * Tauri webview and Node 20+ (vitest), so no extra dependency is needed.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Throws on input that isn't valid base64 — used to detect legacy plaintext values. */
export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
