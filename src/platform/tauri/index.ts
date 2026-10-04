/**
 * The desktop (Tauri) platform layer. Only `src/app` and the entry point
 * import it, and only dynamically after `isTauri()` (src/platform/detect.ts),
 * so the browser build and the tests never load `@tauri-apps/*`.
 */
export { TauriTransport, toSignalCliError, type TauriTransportOptions } from './TauriTransport';
export { tauriNotificationApi } from './notifications';
export { installExternalLinks } from './links';
export {
  createDesktopAdmin,
  createStorageAdmin,
  storageCreateRecovery,
  storageEnrollKeyring,
  storageEraseAll,
  storageKeyringStatus,
  storageRemoveRecovery,
  storageSetPassphrase,
  storageSetup,
  storageStatus,
  storageUnlock,
  storageWebcacheKey,
} from './desktop';
export type { TauriIpc } from './ipc';
