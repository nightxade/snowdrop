/**
 * The desktop (Tauri) platform layer. Only `src/app` and the entry point
 * import it, and only dynamically after `isTauri()` (src/platform/detect.ts),
 * so the browser build and the tests never load `@tauri-apps/*`.
 */
export { TauriTransport, toSignalCliError, type TauriTransportOptions } from './TauriTransport';
export { tauriNotificationApi } from './notifications';
export { installExternalLinks } from './links';
export { logOpenFolder, logRecent, logSetVerbose, sendFrontendLog } from './frontendLog';
export { EVENT_FLUSH_BEFORE_CLOSE, onFlushBeforeClose } from './closeHandshake';
export {
  appCloseReady,
  appRestart,
  createDesktopAdmin,
  createStorageAdmin,
  storageCreateRecovery,
  storageEnrollKeyring,
  storageEraseAll,
  storageKeyringStatus,
  storageRemoveRecovery,
  storageSetPassphrase,
  storageSetup,
  storageSignOut,
  storageStatus,
  storageUnlock,
  storageWebcacheKey,
} from './desktop';
export { getLastIpcCommand } from './ipc';
export type { LastIpcCommand, TauriIpc } from './ipc';

export { readClipboardFiles } from './clipboard';
