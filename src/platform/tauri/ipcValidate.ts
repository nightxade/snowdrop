/**
 * Validates what the Rust side hands back over Tauri IPC before it reaches
 * the UI. `invoke<T>()` is just a type assertion — Rust (or a future
 * refactor of it) can send any JSON it likes, so every command result the
 * UI actually reads (probe, locate, install status, desktop info, the
 * pinned release, and the JSON-RPC reply itself) is decoded here first.
 * An unknown shape becomes a typed `CommandError` (kind `'invalid-response'`,
 * the same kind the Rust side uses for its own malformed-JSON case), not a
 * crash or a field silently reading `undefined`.
 */
import {
  array,
  bool,
  decode,
  isRecord,
  num,
  object,
  oneOf,
  str,
  type Decoder,
  type RpcReply,
} from '@/core/backend/signal-cli';
import type {
  CreateRecoveryResult,
  DesktopInfo,
  EraseResult,
  InstallStatus,
  KeyringStatus,
  PinnedRelease,
  ResolvedProgram,
  StorageReason,
  StorageStatus,
} from '@/core/backend';
import type { CommandError } from './ipc';

/** `null`/`undefined` → `null` (Rust's `Option<T>` serialises as JSON `null`). */
function nullable<T>(d: Decoder<T>): Decoder<T | null> {
  return (v, path, issues) => (v === null || v === undefined ? null : d(v, path, issues));
}

/** A `CommandError` that's also a real `Error`, so it's safe to `throw`. */
class IpcValidationError extends Error implements CommandError {
  override readonly name = 'IpcValidationError';
  readonly kind: CommandError['kind'] = 'invalid-response';
}

function invalidResponse(command: string, message: string): IpcValidationError {
  return new IpcValidationError(`${command}: ${message}`);
}

/** Decodes `value` with `decoder`, throwing a typed `CommandError` on any mismatch. */
function validated<T>(command: string, decoder: Decoder<T>, value: unknown): T {
  const result = decode(decoder, value);
  if (!result.ok) throw invalidResponse(command, result.error.message);
  return result.value;
}

const resolvedProgramShape: Decoder<ResolvedProgram> = object({
  path: str,
  source: oneOf(['downloaded', 'bundled', 'configured', 'path']),
});

export function validateResolvedProgram(command: string, value: unknown): ResolvedProgram {
  return validated(command, resolvedProgramShape, value);
}

export interface RustProbe {
  accounts: number | null;
  version: string | null;
  binary: ResolvedProgram | null;
}

const rustProbeShape: Decoder<RustProbe> = object({
  accounts: nullable(num),
  version: nullable(str),
  binary: nullable(resolvedProgramShape),
});

export function validateProbe(command: string, value: unknown): RustProbe {
  return validated(command, rustProbeShape, value);
}

const desktopInfoShape: Decoder<DesktopInfo> = object({
  managedSignalCli: nullable(str),
  signalCliReleaseUrl: nullable(str),
  signalCliLicense: nullable(str),
  signalCliSource: nullable(str),
  dataDir: str,
  logFile: nullable(str),
});

export function validateDesktopInfo(command: string, value: unknown): DesktopInfo {
  return validated(command, desktopInfoShape, value);
}

const pinnedReleaseShape: Decoder<PinnedRelease> = object({
  version: str,
  repo: str,
  assetName: str,
  downloadSizeBytes: nullable(num),
});

export function validatePinnedRelease(command: string, value: unknown): PinnedRelease {
  return validated(command, pinnedReleaseShape, value);
}

const installStatusShape: Decoder<InstallStatus> = object({
  installed: bool,
  version: nullable(str),
  path: nullable(str),
});

export function validateInstallStatus(command: string, value: unknown): InstallStatus {
  return validated(command, installStatusShape, value);
}

const keyringStatusShape: Decoder<KeyringStatus> = object({
  available: bool,
  hasSecret: bool,
  backend: oneOf(['secret-service', 'macos-keychain', 'windows']),
});

export function validateKeyringStatus(command: string, value: unknown): KeyringStatus {
  return validated(command, keyringStatusShape, value);
}

const storageReasonShape: Decoder<StorageReason> = oneOf([
  'keyringUnavailable',
  'keyringLocked',
  'keyringSecretMissing',
  'passphraseRequired',
  'noRamDir',
  'alreadyRunning',
]);

const storageStatusShape: Decoder<StorageStatus> = object({
  state: oneOf(['needsSetup', 'locked', 'unlocked', 'unavailable']),
  reason: nullable(storageReasonShape),
  hasRecovery: bool,
  hasPassphrase: bool,
  hasKeyring: bool,
  keyringBackend: oneOf(['secret-service', 'macos-keychain', 'windows']),
  legacyPlaintext: bool,
  vaultDisabled: bool,
});

export function validateStorageStatus(command: string, value: unknown): StorageStatus {
  return validated(command, storageStatusShape, value);
}

const createRecoveryResultShape: Decoder<CreateRecoveryResult> = object({
  code: str,
  status: storageStatusShape,
});

export function validateCreateRecoveryResult(command: string, value: unknown): CreateRecoveryResult {
  return validated(command, createRecoveryResultShape, value);
}

const eraseResultShape: Decoder<EraseResult> = object({
  status: storageStatusShape,
  failures: array(str),
});

export function validateEraseResult(command: string, value: unknown): EraseResult {
  return validated(command, eraseResultShape, value);
}

const webcacheKeyResultShape: Decoder<{ keyBase64: string }> = object({ keyBase64: str });

export function validateWebcacheKeyResult(command: string, value: unknown): { keyBase64: string } {
  return validated(command, webcacheKeyResultShape, value);
}

export interface RustInstallProgress {
  received: number;
  total: number | null;
}

const installProgressShape: Decoder<RustInstallProgress> = object({
  received: num,
  total: nullable(num),
});

/** Lenient: a malformed progress tick is dropped rather than failing the install. */
export function tryValidateInstallProgress(value: unknown): RustInstallProgress | null {
  const result = decode(installProgressShape, value);
  return result.ok ? result.value : null;
}

/**
 * Validates `signal_cli_request`'s reply into a `RpcReply` — mirrors
 * `HttpTransport`'s `toReply`, since Tauri IPC is just another transport and
 * gives signal-cli's JSON-RPC envelope no more structural guarantee than a
 * raw HTTP body does. (`JsonRpcClient.call` validates again regardless, but
 * an invalid shape should already be a typed error at this boundary.)
 */
export function validateRpcReply(method: string, payload: unknown): RpcReply {
  if (!isRecord(payload)) {
    throw invalidResponse('signal_cli_request', `${method}: reply is not an object`);
  }
  if (payload.error !== undefined && payload.error !== null) {
    const error = payload.error;
    if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
      throw invalidResponse('signal_cli_request', `${method}: malformed error in reply`);
    }
    return { error: { code: error.code, message: error.message, data: error.data } };
  }
  if ('result' in payload) return { result: payload.result };
  throw invalidResponse(
    'signal_cli_request',
    `${method}: reply has neither a result nor an error`,
  );
}
