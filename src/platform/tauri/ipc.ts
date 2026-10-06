/**
 * The webview side of Snowdrop's Tauri commands (src-tauri/src/commands.rs).
 * The only module that touches `@tauri-apps/api`; everything else in the
 * desktop platform layer takes a `TauriIpc`, so tests pass a fake.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DesktopErrorKind } from '@/core/backend';
import { createLogger } from '@/core/lib';
import type { DesktopConnection } from '@/core/stores';

export interface TauriIpc {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Resolves (with an unlisten function) once the listener is registered. */
  // The payload type is the caller's to state, as with Tauri's own listen.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

const perfLog = createLogger('perf');

/** A command slower than this logs a `perf` warning (never its args or result). */
const SLOW_IPC_MS = 200;

/** A command's name and when it started, in `performance.now()` units. */
export interface LastIpcCommand {
  command: string;
  startedAt: number;
}

let lastIpcCommand: LastIpcCommand | null = null;

/**
 * The most recently *started* real IPC command, whether or not it has
 * resolved yet — command name only, never args or results. Read by the
 * main-thread stall detector (`src/app/perf.ts`) to report, as context for
 * a stall, whichever command was in flight when the gap began.
 */
export function getLastIpcCommand(): LastIpcCommand | null {
  return lastIpcCommand;
}

export const tauriIpc: TauriIpc = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const startedAt = performance.now();
    lastIpcCommand = { command, startedAt };
    const reportIfSlow = (): void => {
      const ms = performance.now() - startedAt;
      if (ms > SLOW_IPC_MS) perfLog.warn(`slow IPC ${command} ${Math.round(ms)} ms`);
    };
    return invoke<T>(command, args).then(
      (value) => {
        reportIfSlow();
        return value;
      },
      (error: unknown) => {
        reportIfSlow();
        throw error;
      },
    );
  },
  listen: (event, handler) =>
    listen(event, (e) => {
      handler(e.payload as never);
    }),
};

/** Event names emitted by the Rust side (src-tauri/src/lib.rs). */
export const EVENT_RECEIVE = 'signal-cli://event';
export const EVENT_STATE = 'signal-cli://state';

/** An error from a command: `{ kind, message }` (src-tauri/src/error.rs). */
export interface CommandError {
  kind: DesktopErrorKind;
  message: string;
}

export function asCommandError(error: unknown): CommandError {
  if (typeof error === 'object' && error !== null && 'kind' in error && 'message' in error) {
    const { kind, message } = error;
    if (typeof kind === 'string' && typeof message === 'string')
      return { kind: kind as CommandError['kind'], message };
  }
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error) };
}

/** The connect configuration the Rust side expects (`ConnectConfig`). */
export function connectConfig(desktop: DesktopConnection): Record<string, unknown> {
  if (desktop.mode === 'external') return { mode: 'external', url: desktop.externalUrl.trim() };
  return {
    mode: 'spawn',
    binaryPath: desktop.binaryPath.trim() || null,
    account: desktop.account.trim() || null,
  };
}
