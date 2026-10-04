/**
 * The desktop app's signal-cli management, as the UI sees it (onboarding,
 * Settings → Connection, About). Implemented by src/platform/tauri; null in
 * the browser.
 */
import type { DesktopConnection } from '@/core/stores';

export type DesktopErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'not-installed'
  | 'config'
  | 'invalid-response'
  | 'cancelled'
  | 'keyring-unavailable'
  | 'keyring-locked'
  | 'keyring-corrupt'
  | 'keyring-secret-missing'
  | 'auth-failed'
  | 'slot-missing'
  | 'keys-file-corrupt'
  | 'recovery-code-typo'
  | 'vault-corrupt'
  | 'vault-blob-corrupt'
  | 'no-ram-dir'
  | 'already-running'
  | 'internal';

export interface ResolvedProgram {
  path: string;
  /** Where it came from: downloaded by Snowdrop, bundled with the app, the configured path, or PATH. */
  source: 'downloaded' | 'bundled' | 'configured' | 'path';
}

export type DesktopProbeResult =
  | { ok: true; accounts: number | null; version: string | null; program: ResolvedProgram | null }
  | { ok: false; kind: DesktopErrorKind; message: string };

export type LocateResult =
  ({ ok: true } & ResolvedProgram) | { ok: false; kind: DesktopErrorKind; message: string };

export interface DesktopInfo {
  /**
   * The signal-cli version Snowdrop manages here — downloaded on first
   * launch, or (only in a `tauri:build:bundled` build) shipped with the app.
   * Null when nothing's installed yet, or Settings → Connection points at a
   * signal-cli the user supplied themselves.
   */
  managedSignalCli: string | null;
  /** Its upstream release page, when `managedSignalCli` is set. */
  signalCliReleaseUrl: string | null;
  /** Only set in a bundled build: its licence text (GPL-3.0). */
  signalCliLicense: string | null;
  /** Only set in a bundled build: where its exact source is. */
  signalCliSource: string | null;
  /** signal-cli's data directory (the linked account lives here). */
  dataDir: string;
  logFile: string | null;
}

/** The signal-cli release this build downloads, for the host it's running on. */
export interface PinnedRelease {
  version: string;
  repo: string;
  assetName: string;
  /** Approximate compressed download size, for the first-run screen's copy. */
  downloadSizeBytes: number | null;
}

export interface InstallStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface InstallProgress {
  received: number;
  /** Null until the response declares a Content-Length. */
  total: number | null;
}

/**
 * Whether the OS keyring can hold Snowdrop's keyring slot secret
 * (src-tauri/src/secrets.rs). Never carries the secret itself.
 */
export interface KeyringStatus {
  /** Whether a keyring answered at all (a locked one still counts). */
  available: boolean;
  /** Whether it already holds a slot secret. */
  hasSecret: boolean;
  backend: 'secret-service' | 'macos-keychain' | 'windows';
}

export type InstallResult =
  | { ok: true; status: InstallStatus }
  | { ok: false; kind: DesktopErrorKind; message: string };

/** `storage_setup`'s `mode` (src-tauri/src/storage.rs). */
export type StorageSetupMode = 'keyring' | 'passphrase';

/** `storage_unlock`'s `method` (src-tauri/src/storage.rs). */
export type StorageUnlockMethod = 'recovery' | 'passphrase';

/** Why storage is `'locked'` or `'unavailable'` (`StorageStatus.reason`). */
export type StorageReason =
  | 'keyringUnavailable'
  | 'keyringLocked'
  | 'keyringSecretMissing'
  | 'passphraseRequired'
  | 'noRamDir'
  | 'alreadyRunning';

/**
 * The storage state machine's status (src-tauri/src/storage.rs), the one
 * shape every `storage_*` command returns so the UI always re-renders from a
 * single source of truth (docs/ENCRYPTION.md).
 */
export interface StorageStatus {
  state: 'needsSetup' | 'locked' | 'unlocked' | 'unavailable';
  /** Only present for `'locked'`/`'unavailable'`. */
  reason: StorageReason | null;
  hasRecovery: boolean;
  hasPassphrase: boolean;
  hasKeyring: boolean;
  keyringBackend: 'secret-service' | 'macos-keychain' | 'windows';
  /** An unencrypted `signal-cli/` dir from before the vault existed. */
  legacyPlaintext: boolean;
  /** `SNOWDROP_SIGNAL_CLI_DATA`, or an external daemon, is in use. */
  vaultDisabled: boolean;
}

/** `storage_create_recovery`'s reply: the plaintext code, shown once. */
export interface CreateRecoveryResult {
  code: string;
  status: StorageStatus;
}

/** `storage_erase_all`'s reply: best-effort, so failures are reported, not thrown. */
export interface EraseResult {
  status: StorageStatus;
  failures: string[];
}

export interface DesktopAdmin {
  /** Checks a configuration without disturbing the running signal-cli. */
  probe(desktop: DesktopConnection): Promise<DesktopProbeResult>;
  /** Which signal-cli program a configuration would run. */
  locate(desktop: Pick<DesktopConnection, 'binaryPath'>): Promise<LocateResult>;
  info(): Promise<DesktopInfo>;
  /** The release this build would download for this host. */
  pinnedRelease(): Promise<PinnedRelease>;
  /** Whether the pinned signal-cli is already downloaded. */
  installStatus(): Promise<InstallStatus>;
  /**
   * Downloads and installs the pinned signal-cli release, calling
   * `onProgress` as bytes arrive. Resolves once installed, or with the
   * reason it couldn't (no network, a checksum mismatch, disk, or that
   * `cancelInstall` was called).
   */
  install(onProgress: (progress: InstallProgress) => void): Promise<InstallResult>;
  /** Cancels a download/install in progress, if any. */
  cancelInstall(): Promise<void>;
}
