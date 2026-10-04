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
  StorageSetupMode,
  StorageStatus,
  StorageUnlockMethod,
} from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { asCommandError, connectConfig, tauriIpc, type TauriIpc } from './ipc';
import {
  tryValidateInstallProgress,
  validateCreateRecoveryResult,
  validateDesktopInfo,
  validateEraseResult,
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
export async function storageCreateRecovery(ipc: TauriIpc = tauriIpc): Promise<CreateRecoveryResult> {
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
 * Deletes the vault, keys.json, the keyring entry and any legacy plaintext
 * data. Best-effort: `failures` lists anything that couldn't be removed.
 */
export async function storageEraseAll(ipc: TauriIpc = tauriIpc): Promise<EraseResult> {
  const raw = await ipc.invoke<unknown>('storage_erase_all', { confirm: 'ERASE' });
  return validateEraseResult('storage_erase_all', raw);
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
          if (import.meta.env.DEV) console.error('desktop_info failed', error);
          return {
            managedSignalCli: null,
            signalCliReleaseUrl: null,
            signalCliLicense: null,
            signalCliSource: null,
            dataDir: '',
            logFile: null,
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
