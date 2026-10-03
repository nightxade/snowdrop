/**
 * Whether the app runs inside the Tauri desktop shell. No Tauri imports
 * here: the browser build (and vitest) never loads `@tauri-apps/*`; code
 * that needs it imports `@/platform/tauri` dynamically after this check.
 */
export function isTauri(): boolean {
  return typeof globalThis !== 'undefined' && '__TAURI_INTERNALS__' in globalThis;
}
