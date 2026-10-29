import { describe, expect, it, vi } from 'vitest';
import { createStores } from '@/core/stores';
import {
  disconnectExternalDaemon,
  leaveDemo,
  signOutDesktop,
  SignOutRestartFailed,
  signOutFlowFor,
} from './signOutFlow';

/** Real stores, with `update` spied so ordering can be asserted. */
function fakeSettingsStore() {
  const stores = createStores();
  stores.settings.getState().update('connection', { backend: 'signal-cli', account: '+15550100' });
  const update = vi.spyOn(stores.settings.getState(), 'update');
  return { store: stores.settings, stores, update };
}

describe('signOutFlowFor', () => {
  it('is "demo" for the mock backend, whatever storageAdmin is', () => {
    expect(signOutFlowFor({ backend: { kind: 'mock' }, storageAdmin: null })).toBe('demo');
    expect(signOutFlowFor({ backend: { kind: 'mock' }, storageAdmin: {} as never })).toBe('demo');
  });

  it('is "desktop" for signal-cli when the desktop storage admin is set', () => {
    expect(signOutFlowFor({ backend: { kind: 'signal-cli' }, storageAdmin: {} as never })).toBe(
      'desktop',
    );
  });

  it('is "browser" for signal-cli with no desktop storage admin', () => {
    expect(signOutFlowFor({ backend: { kind: 'signal-cli' }, storageAdmin: null })).toBe('browser');
  });
});

describe('leaveDemo', () => {
  it('clears the backend choice before awaiting a reload', async () => {
    const order: string[] = [];
    const { stores, update } = fakeSettingsStore();
    const reload = vi.fn(() => {
      order.push('reload');
      return Promise.resolve();
    });
    update.mockImplementation(() => order.push('update'));

    await leaveDemo({ stores, admin: { reload, persist: vi.fn() } as never });

    expect(update).toHaveBeenCalledWith('connection', { backend: null });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['update', 'reload']);
  });
});

describe('disconnectExternalDaemon', () => {
  it('clears the backend choice before awaiting a reload', async () => {
    const order: string[] = [];
    const { stores, update } = fakeSettingsStore();
    const reload = vi.fn(() => {
      order.push('reload');
      return Promise.resolve();
    });
    update.mockImplementation(() => order.push('update'));

    await disconnectExternalDaemon({
      stores,
      admin: { reload, persist: vi.fn() } as never,
    });

    expect(update).toHaveBeenCalledWith('connection', { backend: null });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['update', 'reload']);
  });
});

describe('signOutDesktop', () => {
  it('clears the backend/account choice, then persists, then signs out, then clears history, then restarts', async () => {
    const order: string[] = [];
    const { stores, update } = fakeSettingsStore();
    update.mockImplementation(() => order.push('update'));
    const clearHistory = vi.fn(() => {
      order.push('clearHistory');
      return Promise.resolve();
    });
    const clearAccountData = vi.fn(() => {
      order.push('clearAccountData');
      return Promise.resolve();
    });
    const disconnect = vi.fn(() => {
      order.push('disconnect');
      return Promise.resolve();
    });
    const persist = vi.fn(() => {
      order.push('persist');
      return Promise.resolve();
    });
    const setPendingHistoryClear = vi.fn(() => Promise.resolve());
    const signOut = vi.fn(() => {
      order.push('signOut');
      return Promise.resolve();
    });
    const restart = vi.fn(() => {
      order.push('restart');
      return Promise.resolve();
    });

    await signOutDesktop({
      stores,
      admin: { clearAccountData, clearHistory, disconnect, persist, setPendingHistoryClear },
      storageAdmin: { signOut, restart } as never,
    });

    expect(update).toHaveBeenCalledWith('connection', { backend: null, account: null });
    expect(order).toEqual([
      'update',
      'persist',
      'signOut',
      'disconnect',
      'clearAccountData',
      'clearHistory',
      'restart',
    ]);
    // The happy path never needed the fallback flag.
    expect(setPendingHistoryClear).not.toHaveBeenCalled();
  });

  it('still restarts, and records a pending-clear flag, if clearHistory fails after signOut', async () => {
    const order: string[] = [];
    const { stores } = fakeSettingsStore();
    const clearHistory = vi.fn(() => {
      order.push('clearHistory');
      return Promise.reject(new Error('IDB is busy'));
    });
    const persist = vi.fn(() => Promise.resolve());
    const disconnect = vi.fn(() => Promise.resolve());
    const clearAccountData = vi.fn(() => Promise.resolve());
    const setPendingHistoryClear = vi.fn((pending: boolean) => {
      order.push(`setPendingHistoryClear(${pending})`);
      return Promise.resolve();
    });
    const signOut = vi.fn(() => {
      order.push('signOut');
      return Promise.resolve();
    });
    const restart = vi.fn(() => {
      order.push('restart');
      return Promise.resolve();
    });

    await signOutDesktop({
      stores,
      admin: { clearAccountData, clearHistory, disconnect, persist, setPendingHistoryClear },
      storageAdmin: { signOut, restart } as never,
    });

    expect(order).toEqual(['signOut', 'clearHistory', 'setPendingHistoryClear(true)', 'restart']);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('refuses without a desktop storage admin', async () => {
    const { stores } = fakeSettingsStore();
    await expect(
      signOutDesktop({
        stores,
        admin: {
          clearAccountData: vi.fn(),
          clearHistory: vi.fn(),
          disconnect: vi.fn(() => Promise.resolve()),
          persist: vi.fn(),
          setPendingHistoryClear: vi.fn(),
        },
        storageAdmin: null,
      }),
    ).rejects.toThrow();
  });

  it('still clears history when clearing the account data fails', async () => {
    const { stores } = fakeSettingsStore();
    const clearHistory = vi.fn(() => Promise.resolve());
    const setPendingHistoryClear = vi.fn(() => Promise.resolve());
    const restart = vi.fn(() => Promise.resolve());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await signOutDesktop({
      stores,
      admin: {
        clearAccountData: vi.fn(() => Promise.reject(new Error('storage busy'))),
        clearHistory,
        disconnect: vi.fn(() => Promise.resolve()),
        persist: vi.fn(() => Promise.resolve()),
        setPendingHistoryClear,
      },
      storageAdmin: { signOut: vi.fn(() => Promise.resolve()), restart } as never,
    });

    expect(clearHistory).toHaveBeenCalledTimes(1);
    expect(setPendingHistoryClear).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('holds the app on the running backend for the whole flow, and keeps it there if restart fails', async () => {
    const { stores } = fakeSettingsStore();
    const seen: boolean[] = [];
    const persist = vi.fn(() => {
      seen.push(stores.ui.getState().signingOut);
      return Promise.resolve();
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      signOutDesktop({
        stores,
        admin: {
          clearAccountData: vi.fn(() => Promise.resolve()),
          clearHistory: vi.fn(() => Promise.resolve()),
          disconnect: vi.fn(() => Promise.resolve()),
          persist,
          setPendingHistoryClear: vi.fn(() => Promise.resolve()),
        },
        storageAdmin: {
          signOut: vi.fn(() => Promise.resolve()),
          restart: vi.fn(() => Promise.reject(new Error('no restart'))),
        } as never,
      }),
    ).rejects.toBeInstanceOf(SignOutRestartFailed);
    expect(seen).toEqual([true]);
    expect(stores.ui.getState().signingOut).toBe(true);
    expect(stores.settings.getState().connection.backend).toBeNull();
  });

  it.each(['persist', 'signOut'] as const)(
    'restores the saved connection and rejects when %s fails, so the user stays signed in',
    async (failing) => {
      const { stores } = fakeSettingsStore();
      let persists = 0;
      const persist = vi.fn(() => {
        persists += 1;
        return failing === 'persist' && persists === 1
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve();
      });
      const restart = vi.fn(() => Promise.resolve());
      const clearHistory = vi.fn(() => Promise.resolve());
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        signOutDesktop({
          stores,
          admin: {
            clearAccountData: vi.fn(() => Promise.resolve()),
            clearHistory,
            disconnect: vi.fn(() => Promise.resolve()),
            persist,
            setPendingHistoryClear: vi.fn(() => Promise.resolve()),
          },
          storageAdmin: {
            signOut: vi.fn(() =>
              failing === 'signOut' ? Promise.reject(new Error('vault busy')) : Promise.resolve(),
            ),
            restart,
          } as never,
        }),
      ).rejects.toThrow(failing === 'persist' ? 'disk full' : 'vault busy');
      const { connection } = stores.settings.getState();
      expect(connection.backend).toBe('signal-cli');
      expect(connection.account).toBe('+15550100');
      expect(stores.ui.getState().signingOut).toBe(false);
      // The restored choice is written back, and nothing destructive ran.
      expect(persists).toBe(2);
      expect(clearHistory).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
    },
  );
});

describe('sign-out failures', () => {
  it('restores the choice and rejects when the reload step fails', async () => {
    const { stores } = fakeSettingsStore();
    await expect(
      leaveDemo({
        stores,
        admin: {
          reload: vi.fn(() => Promise.reject(new Error('nope'))),
          persist: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow('nope');
    expect(stores.settings.getState().connection.backend).toBe('signal-cli');
    expect(stores.ui.getState().signingOut).toBe(false);
  });

  it('tells the user the sign-out may be unrecorded when the restore also fails to save', async () => {
    const { stores } = fakeSettingsStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let persists = 0;
    await expect(
      signOutDesktop({
        stores,
        admin: {
          clearAccountData: vi.fn(),
          clearHistory: vi.fn(),
          disconnect: vi.fn(),
          persist: vi.fn(() => {
            persists += 1;
            return persists === 1 ? Promise.resolve() : Promise.reject(new Error('disk full'));
          }),
          setPendingHistoryClear: vi.fn(),
        },
        storageAdmin: {
          signOut: vi.fn(() => Promise.reject(new Error('vault busy'))),
          restart: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow(/vault busy.*still signed in.*Connect/u);
    expect(stores.settings.getState().connection.backend).toBe('signal-cli');
  });

  it('goes on to the restart, never a generic failure, if the pending-clear flag cannot be saved', async () => {
    const { stores } = fakeSettingsStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const restart = vi.fn(() => Promise.reject(new Error('no restart')));
    await expect(
      signOutDesktop({
        stores,
        admin: {
          clearAccountData: vi.fn(() => Promise.resolve()),
          clearHistory: vi.fn(() => Promise.reject(new Error('IDB is busy'))),
          disconnect: vi.fn(() => Promise.resolve()),
          persist: vi.fn(() => Promise.resolve()),
          setPendingHistoryClear: vi.fn(() => Promise.reject(new Error('storage refused'))),
        },
        storageAdmin: { signOut: vi.fn(() => Promise.resolve()), restart } as never,
      }),
    ).rejects.toBeInstanceOf(SignOutRestartFailed);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
