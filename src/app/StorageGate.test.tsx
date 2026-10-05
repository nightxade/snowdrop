/**
 * `StorageGate` routes a desktop boot by `StorageStatus.state`
 * (docs/ENCRYPTION.md, "UX"). A fake `StorageAdmin` stands in for
 * src/platform/tauri, in the style of DownloadSignalCli.test.tsx's
 * `fakeAdmin()`.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { toBase64 } from '@/core/persistence';
import { StorageGate } from './StorageGate';

afterEach(cleanup);
// A fresh IndexedDB per test: a repository left open by one test would
// otherwise block the needsSetup cache discard (and later opens) in the next.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

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

const locked: StorageStatus = { ...needsSetup, state: 'locked', reason: 'keyringLocked', hasRecovery: true };
const unavailable: StorageStatus = { ...needsSetup, state: 'unavailable', reason: 'alreadyRunning' };
const unlocked: StorageStatus = { ...needsSetup, state: 'unlocked' };
const restartRequired: StorageStatus = { ...needsSetup, restartRequired: true };

const randomKeyBase64 = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));

function fakeAdmin(overrides: Partial<StorageAdmin> = {}): StorageAdmin {
  return {
    status: () => Promise.resolve(needsSetup),
    keyringStatus: () =>
      Promise.resolve({ available: true, hasSecret: false, backend: 'secret-service' }),
    setup: () => Promise.resolve(unlocked),
    unlock: () => Promise.resolve(unlocked),
    createRecovery: () => Promise.resolve({ code: 'AAAA', status: unlocked }),
    removeRecovery: () => Promise.resolve(unlocked),
    setPassphrase: () => Promise.resolve(unlocked),
    enrollKeyring: () => Promise.resolve(unlocked),
    webcacheKey: () => Promise.resolve(randomKeyBase64()),
    eraseAll: () => Promise.resolve({ status: needsSetup, failures: [] }),
    signOut: () => Promise.resolve(unlocked),
    restart: () => Promise.resolve(),
    ...overrides,
  };
}

describe('StorageGate: routes every state', () => {
  it('needsSetup shows the setup wizard', async () => {
    render(
      <StorageGate admin={fakeAdmin({ status: () => Promise.resolve(needsSetup) })}>
        {() => <div>never</div>}
      </StorageGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Protect your data' })).toBeTruthy();
  });

  it('locked shows the unlock screen, themed by its reason', async () => {
    render(
      <StorageGate admin={fakeAdmin({ status: () => Promise.resolve(locked) })}>
        {() => <div>never</div>}
      </StorageGate>,
    );
    expect(await screen.findByRole('heading', { name: /Your keyring is locked/u })).toBeTruthy();
  });

  it('unavailable shows an explanatory screen', async () => {
    render(
      <StorageGate admin={fakeAdmin({ status: () => Promise.resolve(unavailable) })}>
        {() => <div>never</div>}
      </StorageGate>,
    );
    expect(await screen.findByRole('heading', { name: /Snowdrop is already open/u })).toBeTruthy();
  });

  it('unlocked fetches the web cache key and renders the children with real persistence', async () => {
    const children = vi.fn(
      (
        persistence: { storage: unknown; repository: unknown },
        _registerFlusher: (flusher: () => Promise<void>) => void,
      ) => <div data-testid="booted">{typeof persistence.storage}</div>,
    );
    render(
      <StorageGate admin={fakeAdmin({ status: () => Promise.resolve(unlocked) })}>{children}</StorageGate>,
    );
    expect(await screen.findByTestId('booted')).toBeTruthy();
    expect(children).toHaveBeenCalledTimes(1);
    const [persistence, registerFlusher] = children.mock.calls[0]!;
    expect(persistence.storage).toBeTruthy();
    expect(persistence.repository).toBeTruthy();
    // The close-handshake registration hook (task 3): always passed, so the
    // booted app can plug its real flush into the gate's one registration.
    expect(typeof registerFlusher).toBe('function');
  });

  it('restartRequired shows a calm restart screen, no matter the state, and restarts on click', async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    render(
      <StorageGate admin={fakeAdmin({ status: () => Promise.resolve(restartRequired), restart })}>
        {() => <div>never</div>}
      </StorageGate>,
    );
    expect(await screen.findByRole('heading', { name: /Restart Snowdrop to finish/u })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Protect your data' })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart Snowdrop' }));
    });
    await waitFor(() => {
      expect(restart).toHaveBeenCalledTimes(1);
    });
  });
});

describe('StorageGate: re-routes when a screen reports a new status', () => {
  it('finishing setup (skip the recovery key) boots the app', async () => {
    const status = vi.fn().mockResolvedValue(needsSetup);
    render(
      <StorageGate admin={fakeAdmin({ status, setup: () => Promise.resolve(unlocked) })}>
        {() => <div data-testid="booted">ready</div>}
      </StorageGate>,
    );
    await screen.findByText(/The key is kept in/u);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]!);
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    });
    expect(await screen.findByTestId('booted')).toBeTruthy();
  });

  it('retrying from the unavailable screen can boot the app once storage is unlocked', async () => {
    const status = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unlocked);
    render(
      <StorageGate admin={fakeAdmin({ status })}>{() => <div data-testid="booted">ready</div>}</StorageGate>,
    );
    await screen.findByRole('heading', { name: /Snowdrop is already open/u });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('booted')).toBeTruthy();
  });
});
