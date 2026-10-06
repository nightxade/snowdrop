/**
 * Writes a frontend error to the app's stderr (`frontend_log`), so a blank
 * window run from a terminal still says what failed.
 */
import { tauriIpc, type TauriIpc } from './ipc';

export function logToTerminal(message: string, ipc: TauriIpc = tauriIpc): void {
  void ipc.invoke('frontend_log', { message }).catch(() => {
    // Nothing else to report it to.
  });
}
