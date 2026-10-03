/**
 * The desktop app's signal-cli management, as the UI sees it (Settings →
 * Connection, About). Implemented by src/platform/tauri; null in the browser.
 */
import type { DesktopConnection } from '@/core/stores';

export type DesktopErrorKind =
  'unreachable' | 'timeout' | 'not-installed' | 'config' | 'invalid-response' | 'internal';

export interface ResolvedProgram {
  path: string;
  /** Where it came from: bundled with the app, the configured path, or PATH. */
  source: 'bundled' | 'configured' | 'path';
}

export type DesktopProbeResult =
  | { ok: true; accounts: number | null; version: string | null; program: ResolvedProgram | null }
  | { ok: false; kind: DesktopErrorKind; message: string };

export type LocateResult =
  ({ ok: true } & ResolvedProgram) | { ok: false; kind: DesktopErrorKind; message: string };

export interface DesktopInfo {
  /** Version of the signal-cli bundled with this build; null without one. */
  bundledSignalCli: string | null;
  /** Its licence text (GPL-3.0) and where its exact source is. */
  signalCliLicense: string | null;
  signalCliSource: string | null;
  /** signal-cli's data directory (the linked account lives here). */
  dataDir: string;
  logFile: string | null;
}

export interface DesktopAdmin {
  /** Checks a configuration without disturbing the running signal-cli. */
  probe(desktop: DesktopConnection): Promise<DesktopProbeResult>;
  /** Which signal-cli program a configuration would run. */
  locate(desktop: Pick<DesktopConnection, 'useBundled' | 'binaryPath'>): Promise<LocateResult>;
  info(): Promise<DesktopInfo>;
}
