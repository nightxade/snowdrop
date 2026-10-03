/**
 * Settings → Connection, About and the first-run download screen in the
 * desktop app: checking a configuration, finding the signal-cli program,
 * what this build ships, and downloading the pinned release.
 */
import type {
  DesktopAdmin,
  DesktopInfo,
  DesktopProbeResult,
  InstallProgress,
  InstallResult,
  InstallStatus,
  LocateResult,
  PinnedRelease,
} from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { asCommandError, connectConfig, tauriIpc, type TauriIpc } from './ipc';
import {
  tryValidateInstallProgress,
  validateDesktopInfo,
  validateInstallStatus,
  validatePinnedRelease,
  validateProbe,
  validateResolvedProgram,
} from './ipcValidate';

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
