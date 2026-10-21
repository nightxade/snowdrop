/**
 * Settings → Connection, About and the first-run download screen in the
 * desktop app: checking a configuration, finding the signal-cli program,
 * what this build ships, and downloading the pinned release.
 */
import type {
  CreateRecoveryResult,
  DesktopAdmin,
  DesktopInfo,
  DesktopProbeResult,
  EraseResult,
  InstallProgress,
  InstallResult,
  InstallStatus,
  KeyringStatus,
  LocateResult,
  PinnedRelease,
  StorageAdmin,
  StorageSetupMode,
  StorageStatus,
  StorageUnlockMethod,
} from '@/core/backend';
import { createLogger } from '@/core/lib';
import type { DesktopConnection } from '@/core/stores';
import { asCommandError, connectConfig, tauriIpc, type TauriIpc } from './ipc';

const log = createLogger('app');
import {
  tryValidateInstallProgress,
  validateCreateRecoveryResult,
  validateDesktopInfo,
  validateEraseResult,
  validateExportEncryptResult,
  validateInstallStatus,
  validateKeyringStatus,
  validatePinnedRelease,
  validateProbe,
  validateResolvedProgram,
  validateStorageStatus,
  validateWebcacheKeyResult,
} from './ipcValidate';

/**
 * Whether the OS keyring can hold Snowdrop's keyring slot secret right now,
 * for the unlock screen and Settings → Privacy & security. Never resolves
 * with the secret itself (see `src-tauri/src/secrets.rs`).
 */
export async function storageKeyringStatus(ipc: TauriIpc = tauriIpc): Promise<KeyringStatus> {
  const raw = await ipc.invoke<unknown>('storage_keyring_status');
  return validateKeyringStatus('storage_keyring_status', raw);
}

/** The storage state machine's status — the UI's one source of truth (docs/ENCRYPTION.md). */
export async function storageStatus(ipc: TauriIpc = tauriIpc): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_status');
  return validateStorageStatus('storage_status', raw);
}

/** First-time setup: creates `keys.json` in keyring or passphrase mode. */
export async function storageSetup(
  mode: StorageSetupMode,
  passphrase: string | null,
  ipc: TauriIpc = tauriIpc,
): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_setup', { mode, passphrase });
  return validateStorageStatus('storage_setup', raw);
}

/**
 * Unlocks with a recovery code or passphrase. `remember` enrols a keyring
 * slot afterwards so future launches unlock silently.
 */
export async function storageUnlock(
  method: StorageUnlockMethod,
  secret: string,
  remember: boolean,
  ipc: TauriIpc = tauriIpc,
): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_unlock', { method, secret, remember });
  return validateStorageStatus('storage_unlock', raw);
}

/** Creates a recovery code, returned in plaintext exactly once. Never log it. */
export async function storageCreateRecovery(
  ipc: TauriIpc = tauriIpc,
): Promise<CreateRecoveryResult> {
  const raw = await ipc.invoke<unknown>('storage_create_recovery');
  return validateCreateRecoveryResult('storage_create_recovery', raw);
}

export async function storageRemoveRecovery(ipc: TauriIpc = tauriIpc): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_remove_recovery');
  return validateStorageStatus('storage_remove_recovery', raw);
}

/** `null` removes the passphrase slot; a string replaces it. */
export async function storageSetPassphrase(
  passphrase: string | null,
  ipc: TauriIpc = tauriIpc,
): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_set_passphrase', { passphrase });
  return validateStorageStatus('storage_set_passphrase', raw);
}

/** Re-enrols a keyring slot for the current provider (e.g. after switching keyrings). */
export async function storageEnrollKeyring(ipc: TauriIpc = tauriIpc): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_enroll_keyring');
  return validateStorageStatus('storage_enroll_keyring', raw);
}

/**
 * Base64 of the 32-byte web cache key, only while unlocked
 * (docs/ENCRYPTION.md, "Web cache"). Fetched once and imported as a
 * non-extractable WebCrypto key; the raw bytes are then dropped.
 */
export async function storageWebcacheKey(ipc: TauriIpc = tauriIpc): Promise<string> {
  const raw = await ipc.invoke<unknown>('storage_webcache_key');
  return validateWebcacheKeyResult('storage_webcache_key', raw).keyBase64;
}

/**
 * Encrypts a history export under a passphrase the user typed (Argon2id +
 * XChaCha20-Poly1305, in Rust: docs/ENCRYPTION.md, "Encrypted history
 * export"). Resolves with the file's bytes as base64. Never log either
 * argument.
 */
export async function storageExportEncrypt(
  passphrase: string,
  plaintext: string,
  ipc: TauriIpc = tauriIpc,
): Promise<string> {
  const raw = await ipc.invoke<unknown>('storage_export_encrypt', { passphrase, plaintext });
  return validateExportEncryptResult('storage_export_encrypt', raw).fileBase64;
}

/**
 * Deletes the vault, keys.json, the keyring entry and any legacy plaintext
 * data. Best-effort: `failures` lists anything that couldn't be removed.
 */
export async function storageEraseAll(ipc: TauriIpc = tauriIpc): Promise<EraseResult> {
  const raw = await ipc.invoke<unknown>('storage_erase_all', { confirm: 'ERASE' });
  return validateEraseResult('storage_erase_all', raw);
}

/**
 * Signs out of Signal on this computer (docs/ENCRYPTION.md, "Sign out"):
 * deletes the vault's manifests, blobs and runtime dir, but keeps
 * `keys.json` and the keyring entry. Like `storageEraseAll`, this latches a
 * restart-required state — call `appRestart` afterwards.
 */
export async function storageSignOut(ipc: TauriIpc = tauriIpc): Promise<StorageStatus> {
  const raw = await ipc.invoke<unknown>('storage_sign_out');
  return validateStorageStatus('storage_sign_out', raw);
}

/**
 * Restarts the whole app process (`AppHandle::restart`, src-tauri/src/commands.rs).
 * Only needed after `storageEraseAll`: the vault bridge and the
 * single-instance lock are one-shot per process (docs/ENCRYPTION.md, "Erase").
 */
export async function appRestart(ipc: TauriIpc = tauriIpc): Promise<void> {
  await ipc.invoke('app_restart');
}

/**
 * Answers the close handshake (docs/ENCRYPTION.md, "signal-cli vault"):
 * tells Rust it's safe to actually close/exit now. See
 * `./closeHandshake.ts`'s `onFlushBeforeClose`, which calls this after
 * running the frontend's own last-write-before-close work.
 */
export async function appCloseReady(ipc: TauriIpc = tauriIpc): Promise<void> {
  await ipc.invoke('app_close_ready');
}

/**
 * Mirrors the computed total unread (`totalUnread` in core/stores/views.ts)
 * to the tray badge, taskbar/dock badge and window title
 * (`src-tauri/src/tray.rs`). See `./unreadSync.ts` for the debounced,
 * change-only caller.
 */
export async function appSetUnread(
  count: number,
  mentions: number,
  ipc: TauriIpc = tauriIpc,
): Promise<void> {
  await ipc.invoke('app_set_unread', { count, mentions });
}

/**
 * Mirrors Settings → Behaviour's "Keep running in the tray" setting
 * (`behaviour.closeToTray`) into Rust, which decides hide-vs-quit at the
 * main window's `CloseRequested` (`src-tauri/src/tray.rs`,
 * `src-tauri/src/lib.rs`) — Rust has no access to the frontend's own
 * settings store to read it directly.
 */
export async function appSetCloseToTray(enabled: boolean, ipc: TauriIpc = tauriIpc): Promise<void> {
  await ipc.invoke('app_set_close_to_tray', { enabled });
}

/** Bundles the `storage_*` wrappers above into the shape `StorageGate` (and Settings) depend on. */
export function createStorageAdmin(ipc: TauriIpc = tauriIpc): StorageAdmin {
  return {
    status: () => storageStatus(ipc),
    keyringStatus: () => storageKeyringStatus(ipc),
    setup: (mode, passphrase) => storageSetup(mode, passphrase, ipc),
    unlock: (method, secret, remember) => storageUnlock(method, secret, remember, ipc),
    createRecovery: () => storageCreateRecovery(ipc),
    removeRecovery: () => storageRemoveRecovery(ipc),
    setPassphrase: (passphrase) => storageSetPassphrase(passphrase, ipc),
    enrollKeyring: () => storageEnrollKeyring(ipc),
    webcacheKey: () => storageWebcacheKey(ipc),
    encryptExport: (passphrase, plaintext) => storageExportEncrypt(passphrase, plaintext, ipc),
    eraseAll: () => storageEraseAll(ipc),
    signOut: () => storageSignOut(ipc),
    restart: () => appRestart(ipc),
  };
}

export function createDesktopAdmin(ipc: TauriIpc = tauriIpc): DesktopAdmin {
  let info: Promise<DesktopInfo> | null = null;
  return {
    async probe(desktop: DesktopConnection): Promise<DesktopProbeResult> {
      try {
        const raw = await ipc.invoke<unknown>('signal_cli_probe', {
          config: connectConfig(desktop),
        });
        const r = validateProbe('signal_cli_probe', raw);
        return { ok: true, accounts: r.accounts, version: r.version, program: r.binary };
      } catch (error) {
        return { ok: false, ...asCommandError(error) };
      }
    },
    async locate(desktop: Pick<DesktopConnection, 'binaryPath'>): Promise<LocateResult> {
      try {
        const raw = await ipc.invoke<unknown>('signal_cli_locate', {
          binaryPath: desktop.binaryPath.trim() || null,
        });
        const r = validateResolvedProgram('signal_cli_locate', raw);
        return { ok: true, ...r };
      } catch (error) {
        return { ok: false, ...asCommandError(error) };
      }
    },
    info(): Promise<DesktopInfo> {
      info ??= ipc
        .invoke<unknown>('desktop_info')
        .then((raw) => validateDesktopInfo('desktop_info', raw))
        .catch((error: unknown): DesktopInfo => {
          info = null;
          if (import.meta.env.DEV) log.error('desktop_info failed', error);
          return {
            managedSignalCli: null,
            signalCliReleaseUrl: null,
            signalCliLicense: null,
            signalCliSource: null,
            dataDir: '',
            logFile: null,
            trayAvailable: false,
          };
        });
      return info;
    },
    async pinnedRelease(): Promise<PinnedRelease> {
      const raw = await ipc.invoke<unknown>('signal_cli_pinned_release');
      return validatePinnedRelease('signal_cli_pinned_release', raw);
    },
    async installStatus(): Promise<InstallStatus> {
      const raw = await ipc.invoke<unknown>('signal_cli_install_status');
      return validateInstallStatus('signal_cli_install_status', raw);
    },
    async install(onProgress: (progress: InstallProgress) => void): Promise<InstallResult> {
      const unlisten = await ipc.listen<unknown>('signal-cli-install-progress', (raw) => {
        // A malformed progress tick is dropped rather than failing the install.
        const p = tryValidateInstallProgress(raw);
        if (p) onProgress({ received: p.received, total: p.total });
      });
      try {
        const raw = await ipc.invoke<unknown>('signal_cli_install');
        const status = validateInstallStatus('signal_cli_install', raw);
        // A fresh install replaces whatever `info()` cached before it existed.
        info = null;
        return { ok: true, status };
      } catch (error) {
        return { ok: false, ...asCommandError(error) };
      } finally {
        unlisten();
      }
    },
    async cancelInstall(): Promise<void> {
      await ipc.invoke('signal_cli_install_cancel');
    },
  };
}
