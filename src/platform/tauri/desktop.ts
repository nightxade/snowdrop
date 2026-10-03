/**
 * Settings → Connection and About in the desktop app: checking a
 * configuration, finding the signal-cli program, and what this build ships.
 */
import type {
  DesktopAdmin,
  DesktopInfo,
  DesktopProbeResult,
  LocateResult,
  ResolvedProgram,
} from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { asCommandError, connectConfig, tauriIpc, type TauriIpc } from './ipc';

interface RustProbe {
  accounts: number | null;
  version: string | null;
  binary: ResolvedProgram | null;
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
    async locate(
      desktop: Pick<DesktopConnection, 'useBundled' | 'binaryPath'>,
    ): Promise<LocateResult> {
      try {
        const r = await ipc.invoke<ResolvedProgram>('signal_cli_locate', {
          useBundled: desktop.useBundled,
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
          bundledSignalCli: null,
          signalCliLicense: null,
          signalCliSource: null,
          dataDir: '',
          logFile: null,
        };
      });
      return info;
    },
  };
}
