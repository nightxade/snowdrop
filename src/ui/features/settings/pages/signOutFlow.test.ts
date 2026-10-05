import { describe, expect, it, vi } from 'vitest';
import {
  disconnectExternalDaemon,
  leaveDemo,
  signOutDesktop,
  signOutFlowFor,
} from './signOutFlow';

function fakeSettingsStore() {
  const update = vi.fn();
  return { store: { getState: () => ({ update }) }, update };
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
    const { store, update } = fakeSettingsStore();
    const reload = vi.fn(() => {
      order.push('reload');
      return Promise.resolve();
    });
    update.mockImplementation(() => order.push('update'));

    await leaveDemo({ stores: { settings: store } as never, admin: { reload } as never });

    expect(update).toHaveBeenCalledWith('connection', { backend: null });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['update', 'reload']);
  });
});

describe('disconnectExternalDaemon', () => {
  it('clears the backend choice before awaiting a reload', async () => {
    const order: string[] = [];
    const { store, update } = fakeSettingsStore();
    const reload = vi.fn(() => {
      order.push('reload');
      return Promise.resolve();
    });
    update.mockImplementation(() => order.push('update'));

    await disconnectExternalDaemon({
      stores: { settings: store } as never,
      admin: { reload } as never,
    });

    expect(update).toHaveBeenCalledWith('connection', { backend: null });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['update', 'reload']);
  });
});

describe('signOutDesktop', () => {
  it('clears history, then the backend/account choice, then persists, then signs out, then restarts', async () => {
    const order: string[] = [];
    const { store, update } = fakeSettingsStore();
    update.mockImplementation(() => order.push('update'));
    const clearHistory = vi.fn(() => {
      order.push('clearHistory');
      return Promise.resolve();
    });
    const persist = vi.fn(() => {
      order.push('persist');
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
      stores: { settings: store } as never,
      admin: { clearHistory, persist },
      storageAdmin: { signOut, restart } as never,
    });

    expect(update).toHaveBeenCalledWith('connection', { backend: null, account: null });
    expect(order).toEqual(['clearHistory', 'update', 'persist', 'signOut', 'restart']);
  });

  it('refuses without a desktop storage admin', async () => {
    const { store } = fakeSettingsStore();
    await expect(
      signOutDesktop({
        stores: { settings: store } as never,
        admin: { clearHistory: vi.fn(), persist: vi.fn() },
        storageAdmin: null,
      }),
    ).rejects.toThrow();
  });
});
