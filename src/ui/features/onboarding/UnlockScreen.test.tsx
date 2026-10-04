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
    eraseAll: () =>
      Promise.resolve({
        status: { ...baseStatus, state: 'needsSetup', reason: null, hasRecovery: false, hasPassphrase: false },
        failures: [],
      }),
    restart: () => Promise.resolve(),
    ...overrides,
  };
}

describe('UnlockScreen: reason copy', () => {
  it('explains a missing keyring service', () => {
    render(
      <UnlockScreen status={{ ...baseStatus, reason: 'keyringUnavailable' }} admin={fakeAdmin()} onStatusChange={() => undefined} />,
    );
    expect(screen.getByRole('heading', { name: /No keyring is available/u })).toBeTruthy();
  });

  it('explains a locked keyring', () => {
    render(
      <UnlockScreen status={{ ...baseStatus, reason: 'keyringLocked' }} admin={fakeAdmin()} onStatusChange={() => undefined} />,
    );
    expect(screen.getByRole('heading', { name: /Your keyring is locked/u })).toBeTruthy();
  });

  it('explains a missing keyring secret (after switching keyrings)', () => {
    render(
      <UnlockScreen status={{ ...baseStatus, reason: 'keyringSecretMissing' }} admin={fakeAdmin()} onStatusChange={() => undefined} />,
    );
    expect(
      screen.getByRole('heading', { name: /keyring doesn.t have Snowdrop.s key/u }),
    ).toBeTruthy();
    expect(screen.getByText(/switching keyrings/u)).toBeTruthy();
  });

  it('explains passphrase mode', () => {
    render(
      <UnlockScreen
        status={{ ...baseStatus, reason: 'passphraseRequired', hasRecovery: false, hasPassphrase: true }}
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
      <UnlockScreen status={baseStatus} admin={fakeAdmin({ unlock })} onStatusChange={onStatusChange} />,
    );
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'AAAA-BBBB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/typo/iu));
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
    render(<UnlockScreen status={baseStatus} admin={fakeAdmin({ unlock })} onStatusChange={() => undefined} />);
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
  it('offers only Start fresh, which requires typing ERASE', async () => {
    const onStatusChange = vi.fn();
    const eraseAll = vi
      .fn()
      .mockResolvedValue({ status: { ...baseStatus, state: 'needsSetup', reason: null }, failures: [] });
    render(
      <UnlockScreen
        status={{ ...baseStatus, hasRecovery: false, hasPassphrase: false }}
        admin={fakeAdmin({ eraseAll })}
        onStatusChange={onStatusChange}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start fresh…' })).toBeTruthy();
    // Nothing to unlock with, and no way "Try again" would help: it's not offered.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

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
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'needsSetup' }),
    );
  });
});

describe('UnlockScreen: try again', () => {
  it('re-checks status and reports it upward', async () => {
    const onStatusChange = vi.fn();
    const status = vi.fn().mockResolvedValue({ ...baseStatus, state: 'unlocked', reason: null });
    render(<UnlockScreen status={baseStatus} admin={fakeAdmin({ status })} onStatusChange={onStatusChange} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await Promise.resolve();
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'unlocked' }),
    );
  });
});
