/**
 * The "Protect your data" wizard (docs/ENCRYPTION.md, "UX" §1): keyring vs
 * passphrase setup, then the recovery-key suggestion. A fake `StorageAdmin`
 * stands in for src/platform/tauri (never loaded here), in the style of
 * DownloadSignalCli.test.tsx's `fakeAdmin()`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { StorageSetup } from './StorageSetup';

afterEach(cleanup);

const needsSetup: StorageStatus = {
  state: 'needsSetup',
  reason: null,
  hasRecovery: false,
  hasPassphrase: false,
  hasKeyring: false,
  keyringBackend: 'secret-service',
  legacyPlaintext: false,
  vaultDisabled: false,
  restartRequired: false,
};

const unlocked: StorageStatus = { ...needsSetup, state: 'unlocked' };

function fakeAdmin(overrides: Partial<StorageAdmin> = {}): StorageAdmin {
  return {
    status: () => Promise.resolve(needsSetup),
    keyringStatus: () =>
      Promise.resolve({ available: true, hasSecret: false, backend: 'secret-service' }),
    setup: () => Promise.resolve(unlocked),
    unlock: () => Promise.resolve(unlocked),
    createRecovery: () =>
      Promise.resolve({
        code: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
        status: { ...unlocked, hasRecovery: true },
      }),
    removeRecovery: () => Promise.resolve(unlocked),
    setPassphrase: () => Promise.resolve(unlocked),
    enrollKeyring: () => Promise.resolve(unlocked),
    webcacheKey: () => Promise.resolve('AAAA'),
    eraseAll: () => Promise.resolve({ status: needsSetup, failures: [] }),
    signOut: () => Promise.resolve(unlocked),
    restart: () => Promise.resolve(),
    ...overrides,
  };
}

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});

describe('StorageSetup: keyring detected', () => {
  it('shows progress while waiting for the keyring, then advances', async () => {
    let finish!: (status: StorageStatus) => void;
    const setup = vi.fn(
      () =>
        new Promise<StorageStatus>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <StorageSetup status={needsSetup} admin={fakeAdmin({ setup })} onDone={() => undefined} />,
    );
    await screen.findByText(/The key is kept in/u);
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]!);
    expect(screen.getByRole('status').textContent).toContain('keyring unlock prompt');
    expect(
      screen.getAllByRole('button', { name: 'Setting up…' })[0]?.hasAttribute('disabled'),
    ).toBe(true);
    act(() => {
      finish(unlocked);
    });
    expect(await screen.findByRole('heading', { name: 'Create a recovery key?' })).toBeTruthy();
  });

  it('offers Continue, then a recovery key that can be created, confirmed and continued', async () => {
    const onDone = vi.fn();
    const createRecovery = vi.fn().mockResolvedValue({
      code: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
      status: { ...unlocked, hasRecovery: true },
    });
    const setup = vi.fn().mockResolvedValue(unlocked);
    render(
      <StorageSetup
        status={needsSetup}
        admin={fakeAdmin({ setup, createRecovery })}
        onDone={onDone}
      />,
    );

    expect(await screen.findByText(/The key is kept in/u)).toBeTruthy();
    // Two "Continue" buttons exist in the DOM (the keyring card's, and the
    // one inside the collapsed "use a passphrase instead" <details>); only
    // the first is actually reachable in a real browser.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]!);
      await Promise.resolve();
    });
    expect(setup).toHaveBeenCalledWith('keyring', null);

    // Recovery-key suggestion step.
    expect(await screen.findByRole('heading', { name: 'Create a recovery key?' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
      await Promise.resolve();
    });
    expect(createRecovery).toHaveBeenCalledTimes(1);

    // The code is shown grouped, with a confirm field for the last group.
    expect(await screen.findByText('IIII')).toBeTruthy();
    const confirm = screen.getByLabelText('Type the last group to confirm');

    // A wrong group doesn't continue.
    fireEvent.change(confirm, { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText("That doesn't match the last group.")).toBeTruthy();

    fireEvent.change(confirm, { target: { value: 'iiii' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ state: 'unlocked' }));
  });

  it('can skip the recovery key', async () => {
    const onDone = vi.fn();
    const createRecovery = vi.fn();
    render(
      <StorageSetup status={needsSetup} admin={fakeAdmin({ createRecovery })} onDone={onDone} />,
    );
    await screen.findByText(/The key is kept in/u);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]!);
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    });
    expect(createRecovery).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('mentions encrypting existing plaintext data when legacyPlaintext is set', async () => {
    render(
      <StorageSetup
        status={{ ...needsSetup, legacyPlaintext: true }}
        admin={fakeAdmin()}
        onDone={() => undefined}
      />,
    );
    expect(await screen.findByText(/earlier, unencrypted copy/u)).toBeTruthy();
  });
});

describe('StorageSetup: no keyring', () => {
  it('explains missing passphrase fields when Continue is pressed', async () => {
    const setup = vi.fn();
    render(
      <StorageSetup
        status={needsSetup}
        admin={fakeAdmin({
          setup,
          keyringStatus: () =>
            Promise.resolve({
              available: false,
              hasSecret: false,
              backend: 'secret-service',
            }),
        })}
        onDone={() => undefined}
      />,
    );
    await screen.findByText(/No keyring was found/u);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter a passphrase.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Passphrase'), {
      target: { value: 'long enough passphrase' },
    });
    expect(screen.getByText('Confirm your passphrase.')).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
  });

  it('validates a passphrase and its confirmation before letting setup proceed', async () => {
    const setup = vi.fn().mockResolvedValue(unlocked);
    render(
      <StorageSetup
        status={needsSetup}
        admin={fakeAdmin({
          setup,
          keyringStatus: () =>
            Promise.resolve({ available: false, hasSecret: false, backend: 'secret-service' }),
        })}
        onDone={() => undefined}
      />,
    );
    expect(await screen.findByText(/No keyring was found/u)).toBeTruthy();

    const passphrase = screen.getByLabelText('Passphrase');
    const confirm = screen.getByLabelText('Confirm passphrase');
    const submit = screen.getByRole('button', { name: 'Continue' });

    // Too short.
    fireEvent.change(passphrase, { target: { value: 'short' } });
    fireEvent.blur(passphrase);
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
    fireEvent.click(submit);
    expect(setup).not.toHaveBeenCalled();

    // Long enough but not confirmed.
    fireEvent.change(passphrase, { target: { value: 'a long enough passphrase' } });
    fireEvent.change(confirm, { target: { value: 'not the same' } });
    fireEvent.blur(confirm);
    expect(screen.getByText("That doesn't match.")).toBeTruthy();
    fireEvent.click(submit);
    expect(setup).not.toHaveBeenCalled();

    // Matching: proceeds.
    fireEvent.change(confirm, { target: { value: 'a long enough passphrase' } });
    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
    });
    expect(setup).toHaveBeenCalledWith('passphrase', 'a long enough passphrase');
  });

  it('links to installing a keyring', async () => {
    render(
      <StorageSetup
        status={needsSetup}
        admin={fakeAdmin({
          keyringStatus: () =>
            Promise.resolve({ available: false, hasSecret: false, backend: 'secret-service' }),
        })}
        onDone={() => undefined}
      />,
    );
    expect(await screen.findByRole('link', { name: /Installing a keyring/u })).toBeTruthy();
  });
});
