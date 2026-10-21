import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { UnlockScreen } from './UnlockScreen';

afterEach(cleanup);

const baseStatus: StorageStatus = {
  state: 'locked',
  reason: 'keyringLocked',
  hasRecovery: true,
  hasPassphrase: false,
  hasKeyring: true,
  keyringBackend: 'secret-service',
  legacyPlaintext: false,
  vaultDisabled: false,
  restartRequired: false,
};

function fakeAdmin(overrides: Partial<StorageAdmin> = {}): StorageAdmin {
  return {
    status: () => Promise.resolve(baseStatus),
    keyringStatus: () =>
      Promise.resolve({ available: true, hasSecret: true, backend: 'secret-service' }),
    setup: () => Promise.resolve(baseStatus),
    unlock: () => Promise.resolve({ ...baseStatus, state: 'unlocked', reason: null }),
    createRecovery: () =>
      Promise.resolve({ code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-IIII', status: baseStatus }),
    removeRecovery: () => Promise.resolve(baseStatus),
    setPassphrase: () => Promise.resolve(baseStatus),
    enrollKeyring: () => Promise.resolve(baseStatus),
    webcacheKey: () => Promise.resolve('AAAA'),
    encryptExport: () => Promise.resolve(''),
    eraseAll: () =>
      Promise.resolve({
        status: {
          ...baseStatus,
          state: 'needsSetup',
          reason: null,
          hasRecovery: false,
          hasPassphrase: false,
        },
        failures: [],
      }),
    signOut: () => Promise.resolve({ ...baseStatus, state: 'unlocked', reason: null }),
    restart: () => Promise.resolve(),
    ...overrides,
  };
}

describe('UnlockScreen: reason copy', () => {
  it('explains a missing keyring service', () => {
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'keyringUnavailable' }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: /No keyring is available/u })).toBeTruthy();
  });

  it('explains a locked keyring', () => {
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'keyringLocked' }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: /Your keyring is locked/u })).toBeTruthy();
  });

  it('explains a missing keyring secret (after switching keyrings)', () => {
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'keyringSecretMissing' }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /keyring doesn.t have Snowdrop.s key/u }),
    ).toBeTruthy();
    expect(screen.getByText(/switching keyrings/u)).toBeTruthy();
  });

  it('branches to the fresh-start copy when neither recovery nor passphrase exists', () => {
    render(
      <UnlockScreen
        status={{
          ...baseStatus,
          reason: 'keyringSecretMissing',
          hasRecovery: false,
          hasPassphrase: false,
        }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /keyring doesn.t have Snowdrop.s key/u }),
    ).toBeTruthy();
    // Never points at a method that doesn't exist.
    expect(screen.queryByText(/unlock with your recovery key or passphrase/iu)).toBeNull();
    expect(
      screen.getByText(/without a recovery key, the data on this computer can.t be opened/iu),
    ).toBeTruthy();
  });

  it('explains passphrase mode', () => {
    render(
      <UnlockScreen
        status={{
          ...baseStatus,
          reason: 'passphraseRequired',
          hasRecovery: false,
          hasPassphrase: true,
        }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: /Enter your passphrase/u })).toBeTruthy();
  });
});

describe('UnlockScreen: wrong secret vs typo', () => {
  it('names a recovery-key typo distinctly from a wrong key', async () => {
    const onStatusChange = vi.fn();
    const unlock = vi.fn().mockRejectedValue({ kind: 'recovery-code-typo', message: 'bad' });
    render(
      <UnlockScreen
        status={baseStatus}
        admin={fakeAdmin({ unlock })}
        onStatusChange={onStatusChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'AAAA-BBBB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringMatching(/typo/iu),
    );
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('reports a wrong passphrase as not matching, not a typo', async () => {
    const unlock = vi.fn().mockRejectedValue({ kind: 'auth-failed', message: 'nope' });
    render(
      <UnlockScreen
        status={{ ...baseStatus, hasRecovery: false, hasPassphrase: true }}
        admin={fakeAdmin({ unlock })}
        onStatusChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await Promise.resolve();
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/didn.t match/iu);
    expect(alert.textContent).not.toMatch(/typo/iu);
  });
});

describe('UnlockScreen: remember on this device', () => {
  it('is on by default when a keyring is available, and passed through to unlock()', async () => {
    const unlock = vi.fn().mockResolvedValue({ ...baseStatus, state: 'unlocked', reason: null });
    render(
      <UnlockScreen
        status={baseStatus}
        admin={fakeAdmin({ unlock })}
        onStatusChange={() => undefined}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Remember on this device' });
    expect(checkbox).toHaveProperty('checked', true);
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'AAAA-BBBB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await Promise.resolve();
    });
    expect(unlock).toHaveBeenCalledWith('recovery', 'AAAA-BBBB', true);
  });

  it('is off by default with no keyring service, and reflects an unchecked box', async () => {
    const unlock = vi.fn().mockResolvedValue({ ...baseStatus, state: 'unlocked', reason: null });
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'keyringUnavailable' }}
        admin={fakeAdmin({ unlock })}
        onStatusChange={() => undefined}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Remember on this device' })).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'AAAA-BBBB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await Promise.resolve();
    });
    expect(unlock).toHaveBeenCalledWith('recovery', 'AAAA-BBBB', false);
  });
});

describe('UnlockScreen: no recovery and no passphrase', () => {
  it('offers only Start fresh when there is truly no keyring angle left', async () => {
    const onStatusChange = vi.fn();
    const eraseAll = vi.fn().mockResolvedValue({
      status: { ...baseStatus, state: 'needsSetup', reason: null },
      failures: [],
    });
    const restart = vi.fn().mockResolvedValue(undefined);
    render(
      <UnlockScreen
        // 'noRamDir' isn't a keyring problem, so re-checking the keyring
        // wouldn't help — it's the one case with no retry offered at all.
        status={{ ...baseStatus, reason: 'noRamDir', hasRecovery: false, hasPassphrase: false }}
        admin={fakeAdmin({ eraseAll, restart })}
        onStatusChange={onStatusChange}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start fresh…' })).toBeTruthy();
    // Nothing to unlock with, and no way "Try again" would help: it's not offered.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check keyring again' })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    });
    const confirmButton = await screen.findByRole('button', { name: 'Erase and start fresh' });
    expect(confirmButton).toHaveProperty('disabled', true);

    const typed = screen.getByLabelText('Type ERASE to confirm');
    fireEvent.change(typed, { target: { value: 'ERAS' } });
    expect(confirmButton).toHaveProperty('disabled', true);
    fireEvent.change(typed, { target: { value: 'ERASE' } });
    expect(confirmButton).toHaveProperty('disabled', false);

    await act(async () => {
      fireEvent.click(confirmButton);
      await Promise.resolve();
    });
    expect(eraseAll).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'needsSetup' }));
    // Matches EncryptionSection's erase flow: the app restarts afterwards
    // (docs/ENCRYPTION.md, "Erase").
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it.each(['keyringLocked', 'keyringUnavailable'] as const)(
    'offers "Check keyring again" as the primary action for %s, with Start fresh secondary',
    async (reasonValue) => {
      const onStatusChange = vi.fn();
      const status = vi.fn().mockResolvedValue({ ...baseStatus, state: 'unlocked', reason: null });
      render(
        <UnlockScreen
          status={{ ...baseStatus, reason: reasonValue, hasRecovery: false, hasPassphrase: false }}
          admin={fakeAdmin({ status })}
          onStatusChange={onStatusChange}
        />,
      );
      const retryButton = screen.getByRole('button', { name: 'Check keyring again' });
      screen.getByRole('button', { name: 'Start fresh…' });
      // The retry is zero-loss (unlock/start the keyring and recheck), so it
      // leads; Start fresh (which loses data) is the secondary option.
      expect(document.activeElement).toBe(retryButton);

      await act(async () => {
        fireEvent.click(retryButton);
        await Promise.resolve();
      });
      expect(status).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'unlocked' }));
    },
  );

  it('keeps Start fresh primary for a missing keyring secret, but still offers a recheck', () => {
    render(
      <UnlockScreen
        status={{
          ...baseStatus,
          reason: 'keyringSecretMissing',
          hasRecovery: false,
          hasPassphrase: false,
        }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    const startFreshButton = screen.getByRole('button', { name: 'Start fresh…' });
    screen.getByRole('button', { name: 'Check keyring again' });
    // The secret itself is missing, not just inaccessible, so starting over
    // is the reliable path — but switching back to the right keyring could
    // still make the secret reappear, so the recheck stays on offer too.
    expect(document.activeElement).toBe(startFreshButton);
  });
});

describe('UnlockScreen: try again', () => {
  it('names the secondary action "Check keyring again" for a keyring-related reason, and re-checks status', async () => {
    const onStatusChange = vi.fn();
    const status = vi.fn().mockResolvedValue({ ...baseStatus, state: 'unlocked', reason: null });
    render(
      <UnlockScreen
        status={baseStatus}
        admin={fakeAdmin({ status })}
        onStatusChange={onStatusChange}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check keyring again' }));
      await Promise.resolve();
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'unlocked' }));
  });

  it('keeps the generic "Try again" label for a non-keyring reason', () => {
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'passphraseRequired', hasPassphrase: true }}
        admin={fakeAdmin()}
        onStatusChange={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check keyring again' })).toBeNull();
  });
});
