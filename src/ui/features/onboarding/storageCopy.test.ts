import { describe, expect, it } from 'vitest';
import {
  errorKind,
  friendlyKeyringBackend,
  groupRecoveryCode,
  passphraseStrength,
  tryAgainLabel,
  unlockReasonCopy,
} from './storageCopy';

describe('errorKind', () => {
  it('reads a thrown command error kind', () => {
    expect(errorKind({ kind: 'auth-failed', message: 'nope' })).toBe('auth-failed');
  });

  it('is null for anything else', () => {
    expect(errorKind(new Error('boom'))).toBeNull();
    expect(errorKind('a string')).toBeNull();
    expect(errorKind(null)).toBeNull();
    expect(errorKind(undefined)).toBeNull();
  });
});

describe('friendlyKeyringBackend', () => {
  it('names every backend', () => {
    expect(friendlyKeyringBackend('secret-service')).toMatch(/keyring/iu);
    expect(friendlyKeyringBackend('macos-keychain')).toMatch(/keychain/iu);
    expect(friendlyKeyringBackend('windows')).toMatch(/credential manager/iu);
  });
});

describe('unlockReasonCopy', () => {
  it('has distinct, specific copy for every reason', () => {
    const reasons = [
      'keyringUnavailable',
      'keyringLocked',
      'keyringSecretMissing',
      'passphraseRequired',
    ] as const;
    const seen = new Set<string>();
    for (const reason of reasons) {
      const { title, body } = unlockReasonCopy(reason);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      expect(seen.has(title)).toBe(false);
      seen.add(title);
    }
  });

  it('mentions switching keyrings for a missing secret', () => {
    expect(unlockReasonCopy('keyringSecretMissing').title).toMatch(/keyring/iu);
  });

  it('falls back to a generic message for an unknown/null reason', () => {
    expect(unlockReasonCopy(null).title).toBe('Snowdrop is locked');
  });

  it('never points at a recovery key or passphrase when neither exists, for every reason', () => {
    const reasons = [
      'keyringUnavailable',
      'keyringLocked',
      'keyringSecretMissing',
      null,
    ] as const;
    for (const reason of reasons) {
      const { body } = unlockReasonCopy(reason, false);
      expect(body).not.toMatch(/unlock with your recovery key or passphrase/iu);
    }
  });

  it('matches the documented copy for a missing keyring secret with no fallback', () => {
    expect(unlockReasonCopy('keyringSecretMissing', false).body).toBe(
      'This happens after switching keyrings. Without a recovery key, the data on this computer can’t be opened.',
    );
  });

  it('defaults to the "can unlock" copy when the flag is omitted', () => {
    expect(unlockReasonCopy('keyringSecretMissing')).toEqual(
      unlockReasonCopy('keyringSecretMissing', true),
    );
  });

  it('explains a missing keyring secret in plain words, without keyring-slot jargon', () => {
    const { body } = unlockReasonCopy('keyringSecretMissing', true);
    expect(body).not.toMatch(/re-enrol/iu);
    expect(body).toMatch(/save its key to your current keyring/iu);
  });
});

describe('tryAgainLabel', () => {
  it('names it "Check keyring again" for keyring-related reasons', () => {
    expect(tryAgainLabel('keyringUnavailable')).toBe('Check keyring again');
    expect(tryAgainLabel('keyringLocked')).toBe('Check keyring again');
    expect(tryAgainLabel('keyringSecretMissing')).toBe('Check keyring again');
  });

  it('keeps "Try again" for every other reason', () => {
    expect(tryAgainLabel('passphraseRequired')).toBe('Try again');
    expect(tryAgainLabel(null)).toBe('Try again');
  });
});

describe('groupRecoveryCode', () => {
  it('groups a plain 36-character code into 9 groups of 4', () => {
    const code = 'A'.repeat(36);
    expect(groupRecoveryCode(code)).toEqual(Array(9).fill('AAAA'));
  });

  it('strips existing dashes and re-groups, uppercasing', () => {
    expect(groupRecoveryCode('abcd-efgh-ijkl')).toEqual(['ABCD', 'EFGH', 'IJKL']);
  });
});

describe('passphraseStrength', () => {
  it('rates short passphrases weak', () => {
    expect(passphraseStrength('abc123')).toBe('weak');
  });

  it('rates a plain 8+ character passphrase fair', () => {
    expect(passphraseStrength('correcthorse')).toBe('fair');
  });

  it('rates a long or varied passphrase good', () => {
    expect(passphraseStrength('correct horse battery staple')).toBe('good');
    expect(passphraseStrength('Abc123!@#def')).toBe('good');
  });
});
