/**
 * Pure helpers for the storage setup/unlock screens (docs/ENCRYPTION.md,
 * "UX", "Recovery slot", "What a fresh start loses"). Kept dependency-free
 * (no platform imports — see linkFlow.ts's `isExpiry` for the same pattern)
 * so they're trivial to unit test and reusable from `StorageSetup`,
 * `UnlockScreen` and `StorageUnavailable`.
 */
import type { StorageReason } from '@/core/backend';

/** A thrown command's `kind`, duck-typed (mirrors `linkFlow.ts`'s `isExpiry`). */
export function errorKind(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'kind' in error ? String(error.kind) : null;
}

const BACKEND_NAMES: Record<'secret-service' | 'macos-keychain' | 'windows', string> = {
  'secret-service': 'your system keyring (GNOME Keyring, KWallet, KeePassXC or similar)',
  'macos-keychain': 'the macOS Keychain',
  windows: 'Windows Credential Manager',
};

/** `KeyringStatus.backend` / `StorageStatus.keyringBackend`, in plain words. */
export function friendlyKeyringBackend(backend: keyof typeof BACKEND_NAMES): string {
  return BACKEND_NAMES[backend];
}

export interface ReasonCopy {
  title: string;
  body: string;
}

/**
 * Why the unlock screen is showing (`StorageStatus.reason`). `canUnlock` —
 * `status.hasRecovery || status.hasPassphrase` — branches the copy: pointing
 * someone at "your recovery key or passphrase" when neither exists would be
 * actively misleading, so that case gets its own sentence explaining that
 * Start fresh (with the loss list) is the only way forward.
 */
export function unlockReasonCopy(reason: StorageReason | null, canUnlock = true): ReasonCopy {
  switch (reason) {
    case 'keyringUnavailable':
      return {
        title: 'No keyring is available',
        body: canUnlock
          ? 'Snowdrop couldn’t reach a keyring service on this system.'
          : 'Snowdrop couldn’t reach a keyring service on this system. Without a recovery key or passphrase, the data on this computer can’t be opened.',
      };
    case 'keyringLocked':
      return {
        title: 'Your keyring is locked',
        body: canUnlock
          ? 'Unlock it, then try again — or unlock with your recovery key or passphrase below.'
          : 'Unlock it, then try again. There’s no recovery key or passphrase set up as a fallback, so until then, the data on this computer can’t be opened.',
      };
    case 'keyringSecretMissing':
      return {
        title: 'Your keyring doesn’t have Snowdrop’s key',
        body: canUnlock
          ? 'This happens after switching keyrings. Unlock with your recovery key or passphrase, and Snowdrop will save its key to your current keyring.'
          : 'This happens after switching keyrings. Without a recovery key, the data on this computer can’t be opened.',
      };
    case 'passphraseRequired':
      return {
        title: 'Enter your passphrase',
        body: 'Snowdrop is set up to ask for a passphrase at every launch.',
      };
    default:
      return {
        title: 'Snowdrop is locked',
        body: canUnlock
          ? 'Unlock with your recovery key or passphrase to continue.'
          : 'There’s no recovery key or passphrase set up, so the data on this computer can’t be opened.',
      };
  }
}

/**
 * The unlock form's secondary action label. Keyring-related reasons point at
 * re-checking the keyring specifically, since "Try again" (re-running the
 * same check) reads as a no-op otherwise; every other reason keeps the
 * generic label.
 */
export function tryAgainLabel(reason: StorageReason | null): string {
  switch (reason) {
    case 'keyringUnavailable':
    case 'keyringLocked':
    case 'keyringSecretMissing':
      return 'Check keyring again';
    default:
      return 'Try again';
  }
}

/** Crockford-base32 groups of 4, re-grouped regardless of how the code arrived (dashed or not). */
export function groupRecoveryCode(code: string): string[] {
  const clean = code.replace(/[^0-9A-Za-z]/gu, '').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups;
}

export type PassphraseStrength = 'weak' | 'fair' | 'good';

/** A rough, non-cryptographic hint — Argon2id does the real work either way. */
export function passphraseStrength(value: string): PassphraseStrength {
  const variety = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^0-9A-Za-z]/u].filter((re) =>
    re.test(value),
  ).length;
  if (value.length >= 16 || (value.length >= 12 && variety >= 2)) return 'good';
  if (value.length >= 8) return 'fair';
  return 'weak';
}
