/**
 * The webview side of `commands::frontend_log`/`log_set_verbose`/
 * `log_recent`/`log_open_folder` (src-tauri/src/commands.rs): the desktop
 * app's half of Settings → Data & storage → Diagnostics, and of the scoped
 * logger's Tauri sink (`src/app/platform.ts`, `src/core/lib/log.ts`).
 */
import type { LogLevel } from '@/core/lib';
import { tauriIpc, type TauriIpc } from './ipc';

/**
 * Writes one line to Snowdrop's own log (target `ui:<scope>`), so a blank
 * window run from a terminal still says what failed. Best-effort: nothing
 * else to report a failed `invoke` to.
 */
export function sendFrontendLog(
  level: LogLevel,
  scope: string,
  message: string,
  ipc: TauriIpc = tauriIpc,
): void {
  void ipc.invoke('frontend_log', { level, scope, message }).catch(() => {
    // Nothing else to report it to.
  });
}

/** Raises (or lowers) the running app's own log floor to Debug. */
export function logSetVerbose(verbose: boolean, ipc: TauriIpc = tauriIpc): Promise<void> {
  return ipc.invoke('log_set_verbose', { verbose });
}

/** The tail of `snowdrop.log` (already redacted); `maxBytes` is capped server-side too. */
export function logRecent(maxBytes: number, ipc: TauriIpc = tauriIpc): Promise<string> {
  return ipc.invoke('log_recent', { maxBytes });
}

/** Opens the log folder in the system file manager. */
export function logOpenFolder(ipc: TauriIpc = tauriIpc): Promise<void> {
  return ipc.invoke('log_open_folder');
}
