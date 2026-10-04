import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage } from './connectionErrors';

describe('friendlyErrorMessage', () => {
  it('hides the raw engine message for kinds that carry exception text', () => {
    expect(friendlyErrorMessage('internal', 'boom (NullPointerException)')).toBe(
      'signal-cli ran into an internal problem.',
    );
    expect(friendlyErrorMessage('user', 'Invalid group id')).toBe(
      'signal-cli rejected that request.',
    );
    expect(friendlyErrorMessage('unreachable', 'TypeError: Failed to fetch')).not.toMatch(
      /TypeError/u,
    );
  });

  it('refines a couple of kinds by sniffing a keyword, without echoing the raw text', () => {
    expect(friendlyErrorMessage('internal', 'No space left on device')).toBe(
      "Couldn't save signal-cli: the disk may be full.",
    );
    expect(friendlyErrorMessage('http', 'Daemon rejected the Host header')).toMatch(
      /Host header/u,
    );
    expect(friendlyErrorMessage('config', 'checksum mismatch: expected a, got b')).toMatch(
      /a checksum mismatch/u,
    );
  });

  it('passes through adapter-crafted copy for kinds meant to already be user-facing', () => {
    expect(friendlyErrorMessage('not-installed', 'No signal-cli at /opt/x. Install it from…')).toBe(
      'No signal-cli at /opt/x. Install it from…',
    );
    expect(friendlyErrorMessage('config', "That file isn't named signal-cli.")).toBe(
      "That file isn't named signal-cli.",
    );
  });

  it('has plain copy for every keyring slot error kind', () => {
    expect(friendlyErrorMessage('keyring-unavailable')).toBe(
      'No keyring service is available on this system.',
    );
    expect(friendlyErrorMessage('keyring-locked')).toBe(
      'The keyring is locked. Unlock it and try again.',
    );
    expect(friendlyErrorMessage('keyring-corrupt')).toBe(
      "The keyring entry Snowdrop stored isn't valid.",
    );
  });

  it('has plain copy for a locked vault', () => {
    expect(friendlyErrorMessage('storage-locked')).toBe(
      'Local storage is locked. Unlock it to connect.',
    );
  });

  it('has plain copy for removing the last unlock method', () => {
    expect(friendlyErrorMessage('last-unlock-method')).toBe(
      "That's the only way left to unlock Snowdrop. Set up another method first.",
    );
  });

  it('falls back to a safe default for an empty detail or an unknown kind', () => {
    expect(friendlyErrorMessage('not-installed', '')).toBe("Snowdrop couldn't find signal-cli.");
    expect(friendlyErrorMessage('something-new', 'whatever')).toBe(
      "Snowdrop couldn't complete that.",
    );
    expect(friendlyErrorMessage(null, 'whatever')).toBe("Snowdrop couldn't complete that.");
    expect(friendlyErrorMessage(undefined)).toBe("Snowdrop couldn't complete that.");
  });
});
