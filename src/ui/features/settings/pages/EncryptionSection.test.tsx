/**
 * Settings → Privacy & security's encryption controls (docs/ENCRYPTION.md,
 * "UX" §4 and §5). A fake `StorageAdmin` stands in for the real one
 * (src/platform/tauri, never loaded here); `EncryptionSection` is rendered
 * inside a real (demo-backed) `Snowdrop` so `useSnowdrop()` — used by the
 * erase flow — has something real to call.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { EraseResult, StorageAdmin, StorageStatus } from '@/core/backend';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { EncryptionSection } from './EncryptionSection';

afterEach(cleanup);

const baseStatus: StorageStatus = {
  state: 'unlocked',
  reason: null,
  hasRecovery: false,
  hasPassphrase: false,
  hasKeyring: true,
  keyringBackend: 'secret-service',
  legacyPlaintext: false,
  vaultDisabled: false,
  restartRequired: false,
};

/** A thrown/rejected `{ kind, message }`, as a real `Error` (asCommandError's shape). */
function commandError(kind: string, message: string): Error & { kind: string } {
  return Object.assign(new Error(message), { kind });
}

/**
 * Plain `vi.fn()` spies, not typed through `StorageAdmin` (whose methods use
 * interface shorthand): asserting on a spy here never trips
 * @typescript-eslint/unbound-method the way `expect(admin.x)` would.
 */
function makeSpies(overrides: Partial<StorageAdmin> = {}) {
  const base = {
    status: vi.fn(() => Promise.resolve(baseStatus)),
    keyringStatus: vi.fn(() =>
      Promise.resolve({ available: true, hasSecret: true, backend: 'secret-service' as const }),
    ),
    setup: vi.fn(() => Promise.resolve(baseStatus)),
    unlock: vi.fn(() => Promise.resolve(baseStatus)),
    createRecovery: vi.fn(() =>
      Promise.resolve({
        code: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ',
        status: { ...baseStatus, hasRecovery: true },
      }),
    ),
    removeRecovery: vi.fn(() => Promise.resolve({ ...baseStatus, hasRecovery: false })),
    setPassphrase: vi.fn((p: string | null) =>
      Promise.resolve({ ...baseStatus, hasPassphrase: p !== null }),
    ),
    enrollKeyring: vi.fn(() => Promise.resolve(baseStatus)),
    webcacheKey: vi.fn(() => Promise.resolve('AAAA')),
    encryptExport: vi.fn(() => Promise.resolve('')),
    eraseAll: vi.fn<() => Promise<EraseResult>>(() =>
      Promise.resolve({ status: { ...baseStatus, state: 'needsSetup' }, failures: [] }),
    ),
    signOut: vi.fn<() => Promise<StorageStatus>>(() =>
      Promise.resolve({ ...baseStatus, state: 'needsSetup', restartRequired: true }),
    ),
    restart: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
  // Every override used by these tests is itself a `vi.fn()`, so this keeps
  // the concrete (narrow) `Mock` type above rather than widening each
  // overridden property to a plain-function union that loses `.mock`.
  return { ...base, ...overrides } as typeof base;
}

type Spies = ReturnType<typeof makeSpies>;

function makeAdmin(overrides: Partial<StorageAdmin> = {}): { admin: StorageAdmin; spies: Spies } {
  const spies = makeSpies(overrides);
  return { admin: spies, spies };
}

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  await snowdrop?.dispose();
  snowdrop = null;
});

async function mount(admin: StorageAdmin) {
  snowdrop = await bootSnowdrop();
  renderWithSnowdrop(snowdrop, <EncryptionSection admin={admin} />);
  // "Encrypted on this computer" shows during the brief "Checking…" phase
  // too, so wait for that placeholder to clear rather than for the label.
  await waitFor(() => {
    expect(screen.queryByText('Checking…')).toBeNull();
  });
}

describe('EncryptionSection: status', () => {
  it('shows the keyring backend when a keyring secret exists', async () => {
    const { admin } = makeAdmin({ status: () => Promise.resolve(baseStatus) });
    await mount(admin);
    expect(await screen.findByText(/Key kept in your system keyring/u)).toBeTruthy();
  });

  it('shows passphrase-only mode', async () => {
    const { admin } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, hasKeyring: false, hasPassphrase: true }),
    });
    await mount(admin);
    expect(
      await screen.findByText('Snowdrop asks for your passphrase at every launch.'),
    ).toBeTruthy();
  });

  it('warns when nothing can unlock automatically next time', async () => {
    const { admin } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, hasKeyring: false }),
    });
    await mount(admin);
    expect(await screen.findByText(/Unlocked for this session only/u)).toBeTruthy();
  });

  it('shows a clear warning when the vault is disabled', async () => {
    const { admin } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, vaultDisabled: true }),
    });
    await mount(admin);
    expect(await screen.findByText(/signal-cli’s data is managed outside Snowdrop/u)).toBeTruthy();
  });

  it('shows an error instead of crashing when status fails', async () => {
    const { admin } = makeAdmin({ status: () => Promise.reject(commandError('internal', 'boom')) });
    await mount(admin);
    expect(await screen.findByText('signal-cli ran into an internal problem.')).toBeTruthy();
  });
});

describe('EncryptionSection: recovery key', () => {
  it('creates a recovery key and requires the last group to confirm', async () => {
    const { admin, spies } = makeAdmin();
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
    });
    await waitFor(() => {
      expect(spies.createRecovery.mock.calls.length).toBeGreaterThan(0);
    });
    expect(await screen.findByText('Your recovery key')).toBeTruthy();

    const confirmField = screen.getByLabelText('Type the last group to confirm');
    act(() => {
      fireEvent.change(confirmField, { target: { value: 'WRONG' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(await screen.findByText("That doesn't match the last group.")).toBeTruthy();

    act(() => {
      fireEvent.change(confirmField, { target: { value: 'JJJJ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    // Reveal modal closes and the row now offers "Replace…" (status refreshed).
    await waitFor(() => {
      expect(screen.queryByText('Your recovery key')).toBeNull();
    });
    expect(await screen.findByRole('button', { name: 'Replace…' })).toBeTruthy();
  });

  it('shows a clipboard hint after copying the recovery key', async () => {
    const { admin } = makeAdmin();
    await mount(admin);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create recovery key' }));
    });
    expect(await screen.findByText('Your recovery key')).toBeTruthy();
    expect(screen.queryByText(/paste it somewhere safe/iu)).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(
      await screen.findByText(/Copied\. Paste it somewhere safe, then clear your clipboard\./u),
    ).toBeTruthy();
  });

  it('replace warns the old key stops working, then creates a new one', async () => {
    const { admin, spies } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, hasRecovery: true }),
    });
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    });
    expect(await screen.findByText('Replace recovery key?')).toBeTruthy();
    expect(screen.getByText(/stops the old key working/u)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create new key' }));
    });
    await waitFor(() => {
      expect(spies.createRecovery.mock.calls.length).toBeGreaterThan(0);
    });
    expect(await screen.findByText('Your recovery key')).toBeTruthy();
  });

  it('removes the recovery key after confirming', async () => {
    const { admin, spies } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, hasRecovery: true }),
    });
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    });
    expect(await screen.findByText('Remove recovery key?')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    await waitFor(() => {
      expect(spies.removeRecovery.mock.calls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create recovery key' })).toBeTruthy();
    });
  });

  it('disables removing the recovery key when it is the only unlock method', async () => {
    const { admin, spies } = makeAdmin({
      status: () =>
        Promise.resolve({
          ...baseStatus,
          hasKeyring: false,
          hasRecovery: true,
          hasPassphrase: false,
        }),
    });
    await mount(admin);

    const remove = screen.getByRole('button', { name: 'Remove…' });
    expect(remove).toHaveProperty('disabled', true);
    expect(screen.getByText(/only way left to unlock Snowdrop/iu)).toBeTruthy();

    act(() => {
      fireEvent.click(remove);
    });
    expect(screen.queryByText('Remove recovery key?')).toBeNull();
    expect(spies.removeRecovery.mock.calls.length).toBe(0);
  });
});

describe('EncryptionSection: passphrase', () => {
  it('validates length and confirmation before saving', async () => {
    const { admin, spies } = makeAdmin();
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add passphrase' }));
    });
    const save = await screen.findByRole('button', { name: 'Save' });
    const passphrase = screen.getByLabelText('New passphrase');
    const confirm = screen.getByLabelText('Confirm passphrase');

    act(() => {
      fireEvent.change(passphrase, { target: { value: 'short' } });
      fireEvent.click(save);
    });
    expect(await screen.findByText('Use at least 8 characters.')).toBeTruthy();
    expect(spies.setPassphrase.mock.calls.length).toBe(0);

    act(() => {
      fireEvent.change(passphrase, { target: { value: 'longenough' } });
      fireEvent.change(confirm, { target: { value: 'different' } });
      fireEvent.click(save);
    });
    expect(await screen.findByText("That doesn't match.")).toBeTruthy();
    expect(spies.setPassphrase.mock.calls.length).toBe(0);

    act(() => {
      fireEvent.change(confirm, { target: { value: 'longenough' } });
      fireEvent.click(save);
    });
    await waitFor(() => {
      expect(spies.setPassphrase.mock.calls.at(-1)).toEqual(['longenough']);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change…' })).toBeTruthy();
    });
  });

  it('removes the passphrase after confirming', async () => {
    const { admin, spies } = makeAdmin({
      status: () => Promise.resolve({ ...baseStatus, hasPassphrase: true }),
    });
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    });
    expect(await screen.findByText('Remove passphrase?')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    await waitFor(() => {
      expect(spies.setPassphrase.mock.calls.at(-1)).toEqual([null]);
    });
  });

  it('clears the passphrase fields after a successful save (never kept around)', async () => {
    const { admin } = makeAdmin();
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add passphrase' }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText('New passphrase'), {
        target: { value: 'longenough' },
      });
      fireEvent.change(screen.getByLabelText('Confirm passphrase'), {
        target: { value: 'longenough' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change…' })).toBeTruthy();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    });
    expect(screen.getByLabelText<HTMLInputElement>('New passphrase').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Confirm passphrase').value).toBe('');
  });

  it('clears the passphrase fields on cancel', async () => {
    const { admin } = makeAdmin();
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add passphrase' }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText('New passphrase'), {
        target: { value: 'some-secret' },
      });
      fireEvent.change(screen.getByLabelText('Confirm passphrase'), {
        target: { value: 'some-secret' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add passphrase' }));
    });
    expect(screen.getByLabelText<HTMLInputElement>('New passphrase').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Confirm passphrase').value).toBe('');
  });

  it('disables removing the passphrase when it is the only unlock method', async () => {
    const { admin } = makeAdmin({
      status: () =>
        Promise.resolve({
          ...baseStatus,
          hasKeyring: false,
          hasRecovery: false,
          hasPassphrase: true,
        }),
    });
    await mount(admin);

    const remove = screen.getByRole('button', { name: 'Remove…' });
    expect(remove).toHaveProperty('disabled', true);
    expect(screen.getByText(/only way left to unlock Snowdrop/iu)).toBeTruthy();

    act(() => {
      fireEvent.click(remove);
    });
    expect(screen.queryByText('Remove passphrase?')).toBeNull();
  });
});

describe('EncryptionSection: keyring', () => {
  it('shows the re-enrol result', async () => {
    const { admin, spies } = makeAdmin();
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-save' }));
    });
    await waitFor(() => {
      expect(spies.enrollKeyring.mock.calls.length).toBeGreaterThan(0);
    });
    expect(await screen.findByText(/Saved\./u)).toBeTruthy();
  });

  it('shows a friendly message when re-enrolling fails', async () => {
    const { admin } = makeAdmin({
      enrollKeyring: vi.fn(() => Promise.reject(commandError('keyring-locked', 'locked'))),
    });
    await mount(admin);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-save' }));
    });
    expect(await screen.findByText('The keyring is locked. Unlock it and try again.')).toBeTruthy();
  });
});

describe('EncryptionSection: erase all local data', () => {
  it('requires typing ERASE, then erases, stops persistence, and restarts, in order', async () => {
    const { admin, spies } = makeAdmin();
    await mount(admin);
    const order: string[] = [];
    vi.spyOn(snowdrop!.admin, 'stopPersistence').mockImplementation(() => {
      order.push('stopPersistence');
    });
    spies.eraseAll.mockImplementation(() => {
      order.push('eraseAll');
      return Promise.resolve({ status: { ...baseStatus, state: 'needsSetup' }, failures: [] });
    });
    spies.restart.mockImplementation(() => {
      order.push('restart');
      return Promise.resolve();
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Erase…' }));
    });
    expect(await screen.findByText('Erase all local data?')).toBeTruthy();

    const eraseButton = screen.getByRole('button', { name: 'Erase and restart' });
    expect(eraseButton.hasAttribute('disabled')).toBe(true);

    const confirmField = screen.getByLabelText('Type ERASE to confirm');
    act(() => {
      fireEvent.change(confirmField, { target: { value: 'nope' } });
    });
    expect(eraseButton.hasAttribute('disabled')).toBe(true);

    act(() => {
      fireEvent.change(confirmField, { target: { value: 'ERASE' } });
    });
    expect(eraseButton.hasAttribute('disabled')).toBe(false);

    act(() => {
      fireEvent.click(eraseButton);
    });

    await waitFor(() => {
      expect(spies.restart.mock.calls.length).toBeGreaterThan(0);
    });
    // eraseAll runs first: persistence is only stopped once the erase has
    // actually succeeded (docs/ENCRYPTION.md, "Erase").
    expect(order).toEqual(['eraseAll', 'stopPersistence', 'restart']);
  });

  it('shows an error, leaves persistence running, and never restarts if eraseAll fails', async () => {
    const { admin, spies } = makeAdmin({
      eraseAll: vi.fn(() => Promise.reject(commandError('internal', 'disk full'))),
    });
    await mount(admin);
    const stopPersistence = vi.spyOn(snowdrop!.admin, 'stopPersistence');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Erase…' }));
    });
    const confirmField = await screen.findByLabelText('Type ERASE to confirm');
    act(() => {
      fireEvent.change(confirmField, { target: { value: 'ERASE' } });
      fireEvent.click(screen.getByRole('button', { name: 'Erase and restart' }));
    });

    expect(await screen.findByText('signal-cli ran into an internal problem.')).toBeTruthy();
    // Settings must keep saving after a failed erase: stopPersistence()
    // never ran, and the app never restarted into the half-erased state.
    expect(stopPersistence).not.toHaveBeenCalled();
    expect(spies.restart.mock.calls.length).toBe(0);
  });

  it('offers an explicit restart retry, never the destructive button again, if restart fails after erase succeeds', async () => {
    const { admin, spies } = makeAdmin({
      restart: vi.fn(() => Promise.reject(commandError('internal', 'IPC timed out'))),
    });
    await mount(admin);
    vi.spyOn(snowdrop!.admin, 'stopPersistence').mockImplementation(() => undefined);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Erase…' }));
    });
    const confirmField = await screen.findByLabelText('Type ERASE to confirm');
    act(() => {
      fireEvent.change(confirmField, { target: { value: 'ERASE' } });
      fireEvent.click(screen.getByRole('button', { name: 'Erase and restart' }));
    });

    expect(await screen.findByText('signal-cli ran into an internal problem.')).toBeTruthy();
    // The data is already gone: never re-offer the destructive action.
    expect(screen.queryByRole('button', { name: 'Erase and restart' })).toBeNull();
    expect(screen.queryByLabelText('Type ERASE to confirm')).toBeNull();
    expect(screen.getByText('Restart Snowdrop to finish')).toBeTruthy();
    expect(screen.getByText(/close Snowdrop and reopen it yourself/u)).toBeTruthy();

    const retry = screen.getByRole('button', { name: 'Restart Snowdrop' });
    spies.restart.mockImplementationOnce(() => Promise.resolve());
    act(() => {
      fireEvent.click(retry);
    });
    await waitFor(() => {
      expect(spies.restart.mock.calls.length).toBe(2);
    });
  });
});
