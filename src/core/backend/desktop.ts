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
  /**
   * Removing a recovery or passphrase slot would leave no way to ever
   * unlock Snowdrop again. The UI should explain that another method needs
   * setting up first, not just show a generic failure.
   */
  | 'last-unlock-method'
  | 'keys-file-corrupt'
  | 'recovery-code-typo'
  | 'vault-corrupt'
  | 'vault-blob-corrupt'
  | 'no-ram-dir'
  | 'already-running'
  /**
   * `signal_cli_connect` while storage is `'locked'` or `'needsSetup'`: the
   * signal-cli vault can't be restored or created yet. The UI should route
   * to the unlock or setup screen rather than retry.
   */
  | 'storage-locked'
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
  { ok: true; status: InstallStatus } | { ok: false; kind: DesktopErrorKind; message: string };

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
  /**
   * `true` once "Erase all local data" has run in this process: `state` is
   * `'needsSetup'`, but every other storage command refuses until the app
   * restarts (docs/ENCRYPTION.md, "Erase").
   */
  restartRequired: boolean;
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

/**
 * Encrypted storage, as the bootstrap gate and the setup/unlock screens see
 * it (docs/ENCRYPTION.md, "UX"). Implemented by `src/platform/tauri`; the
 * gate (`src/app/StorageGate.tsx`) is the only thing that calls it directly.
 */
export interface StorageAdmin {
  status(): Promise<StorageStatus>;
  /** Whether the OS keyring is usable right now, for the setup screen's default. */
  keyringStatus(): Promise<KeyringStatus>;
  setup(mode: StorageSetupMode, passphrase: string | null): Promise<StorageStatus>;
  unlock(method: StorageUnlockMethod, secret: string, remember: boolean): Promise<StorageStatus>;
  /** The plaintext code, shown once. Never log it. */
  createRecovery(): Promise<CreateRecoveryResult>;
  /** Removes the recovery slot, if any (Settings → Privacy & security). */
  removeRecovery(): Promise<StorageStatus>;
  /** `null` removes the passphrase slot; a string adds or replaces it. */
  setPassphrase(passphrase: string | null): Promise<StorageStatus>;
  /** Re-enrols a keyring slot for the current provider (e.g. after switching keyrings). */
  enrollKeyring(): Promise<StorageStatus>;
  /** Base64 of the 32-byte web cache key; only resolves while unlocked. */
  webcacheKey(): Promise<string>;
  eraseAll(): Promise<EraseResult>;
  /**
   * Signs out of Signal on this computer (docs/ENCRYPTION.md, "Sign out"):
   * removes this computer's signal-cli vault (keys, sessions, contacts and
   * message history), but keeps `keys.json`, the keyring entry and every
   * Snowdrop setting — storage stays set up, so a restart finds it already
   * unlocked. Only resolves while `signal-cli` and unlocked; the caller
   * must flush its own settings first (they're kept) and restart
   * afterwards (the vault bridge is one-shot per process, same as `eraseAll`).
   */
  signOut(): Promise<StorageStatus>;
  /**
   * Restarts the whole app process. Only needed after `eraseAll`: the vault
   * bridge and the single-instance lock are one-shot per process
   * (docs/ENCRYPTION.md, "Erase").
   */
  restart(): Promise<void>;
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
