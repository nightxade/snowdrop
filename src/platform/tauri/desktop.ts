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
  ResolvedProgram,
} from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { asCommandError, connectConfig, tauriIpc, type TauriIpc } from './ipc';

interface RustProbe {
  accounts: number | null;
  version: string | null;
  binary: ResolvedProgram | null;
}

interface RustPinnedAsset {
  version: string;
  repo: string;
  assetName: string;
  downloadSizeBytes: number | null;
}

interface RustInstallStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

interface RustInstallProgress {
  received: number;
  total: number | null;
}

function toInstallStatus(r: RustInstallStatus): InstallStatus {
  return { installed: r.installed, version: r.version, path: r.path };
}

export function createDesktopAdmin(ipc: TauriIpc = tauriIpc): DesktopAdmin {
  let info: Promise<DesktopInfo> | null = null;
  return {
    async probe(desktop: DesktopConnection): Promise<DesktopProbeResult> {
      try {
        const r = await ipc.invoke<RustProbe>('signal_cli_probe', {
          config: connectConfig(desktop),
        });
        return { ok: true, accounts: r.accounts, version: r.version, program: r.binary };
      } catch (error) {
        return { ok: false, ...asCommandError(error) };
      }
    },
    async locate(desktop: Pick<DesktopConnection, 'binaryPath'>): Promise<LocateResult> {
      try {
        const r = await ipc.invoke<ResolvedProgram>('signal_cli_locate', {
          binaryPath: desktop.binaryPath.trim() || null,
        });
        return { ok: true, ...r };
      } catch (error) {
        return { ok: false, ...asCommandError(error) };
      }
    },
    info(): Promise<DesktopInfo> {
      info ??= ipc.invoke<DesktopInfo>('desktop_info').catch((): DesktopInfo => {
        info = null;
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
      const r = await ipc.invoke<RustPinnedAsset>('signal_cli_pinned_release');
      return {
        version: r.version,
        repo: r.repo,
        assetName: r.assetName,
        downloadSizeBytes: r.downloadSizeBytes,
      };
    },
    async installStatus(): Promise<InstallStatus> {
      return toInstallStatus(await ipc.invoke<RustInstallStatus>('signal_cli_install_status'));
    },
    async install(onProgress: (progress: InstallProgress) => void): Promise<InstallResult> {
      const unlisten = await ipc.listen<RustInstallProgress>('signal-cli-install-progress', (p) => {
        onProgress({ received: p.received, total: p.total });
      });
      try {
        const status = await ipc.invoke<RustInstallStatus>('signal_cli_install');
        // A fresh install replaces whatever `info()` cached before it existed.
        info = null;
        return { ok: true, status: toInstallStatus(status) };
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
