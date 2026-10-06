/**
 * Writes a frontend error to Snowdrop's own log (`frontend_log`, target
 * `ui:app`, level `error`), so a blank window run from a terminal still
 * says what failed. A later pass gives the frontend its own structured
 * logger (levels, scopes); this is just the minimal command-contract
 * update for `commands::frontend_log`'s new `(level, scope, message)`
 * signature.
 */
import { tauriIpc, type TauriIpc } from './ipc';

export function logToTerminal(message: string, ipc: TauriIpc = tauriIpc): void {
  void ipc.invoke('frontend_log', { level: 'error', scope: 'app', message }).catch(() => {
    // Nothing else to report it to.
  });
}
