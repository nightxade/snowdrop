/**
 * Settings → Connection in the desktop app: a fake DesktopAdmin stands in for
 * src/platform/tauri (never loaded here), injected the way the real app does
 * it — isTauri() true, @/platform/tauri mocked — rather than mocking globals
 * the component reads directly.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAdmin, DesktopInfo, DesktopProbeResult, LocateResult } from '@/core/backend';
import { SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { createMemoryStorage, MemoryMessageRepository } from '@/core/persistence';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ConnectionPage } from './ConnectionPage';

function fakeDesktopAdmin(): DesktopAdmin {
  const info: DesktopInfo = {
    managedSignalCli: '0.14.8',
    signalCliReleaseUrl: 'https://github.com/AsamK/signal-cli/releases/tag/v0.14.8',
    signalCliLicense: null,
    signalCliSource: null,
    dataDir: '/home/me/.local/share/signal-cli',
    logFile: null,
    trayAvailable: false,
  };
  return {
    probe: (): Promise<DesktopProbeResult> =>
      Promise.resolve({ ok: true, accounts: 0, version: '0.14.8', program: null }),
    locate: (value): Promise<LocateResult> =>
      Promise.resolve(
        value.binaryPath
          ? { ok: false, kind: 'not-installed', message: 'No signal-cli on your PATH.' }
          : { ok: true, path: '/opt/snowdrop/signal-cli', source: 'downloaded' },
      ),
    info: () => Promise.resolve(info),
    pinnedRelease: () =>
      Promise.resolve({
        version: '0.14.8',
        repo: 'https://github.com/AsamK/signal-cli',
        assetName: 'signal-cli-0.14.8-Linux-native.tar.gz',
        downloadSizeBytes: 114_000_000,
      }),
    installStatus: () =>
      Promise.resolve({ installed: true, version: '0.14.8', path: '/opt/snowdrop/signal-cli' }),
    install: () =>
      Promise.resolve({
        ok: true,
        status: { installed: true, version: '0.14.8', path: '/opt/snowdrop/signal-cli' },
      }),
    cancelInstall: () => Promise.resolve(),
  };
}

vi.mock('@/platform/tauri', () => ({ createDesktopAdmin: fakeDesktopAdmin }));

async function bootDesktopSnowdrop(): Promise<Snowdrop> {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const snowdrop = createSnowdrop({
    storage: createMemoryStorage(),
    mockLatencyMs: 0,
    notificationApi: {
      permission: () => 'default',
      request: () => Promise.resolve('unsupported'),
      show: () => null,
    },
  });
  snowdrop.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await act(async () => {
    await snowdrop.start();
    await snowdrop.sync.idle();
  });
  return snowdrop;
}

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('Settings → Connection, desktop build', () => {
  it('shows the desktop rows (no daemon-address field) once signal-cli is selected', async () => {
    snowdrop = await bootDesktopSnowdrop();
    expect(snowdrop.desktop).not.toBeNull();
    renderWithSnowdrop(snowdrop, <ConnectionPage />);

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'signal-cli' }));
    });

    expect(screen.getByText('Run signal-cli')).toBeTruthy();
    expect(
      await screen.findByText(/Snowdrop will run the signal-cli Snowdrop downloaded\./u),
    ).toBeTruthy();
    // The browser-only daemon-address/account fields are gone in the desktop build.
    expect(screen.queryByLabelText('Daemon address')).toBeNull();
    expect(screen.queryByText(/same-origin proxy path/u)).toBeNull();
  });
});

describe('Settings → Connection, desktop build: stray spaces', () => {
  it('does not count spaces around the account as a change, and saves the trimmed value', async () => {
    snowdrop = await bootDesktopSnowdrop();
    snowdrop.stores.settings.getState().update('connection', {
      backend: 'signal-cli',
      desktop: { ...snowdrop.stores.settings.getState().connection.desktop, account: '+15550100' },
    });
    renderWithSnowdrop(snowdrop, <ConnectionPage />);
    const field = await screen.findByLabelText('One account only');
    act(() => {
      fireEvent.change(field, { target: { value: '  +15550100  ' } });
    });
    // Switching to signal-cli shows the apply bar anyway; the dialog says whether history would be cleared.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
    });
    expect(screen.getByText(/Unsent drafts are kept\./u)).toBeTruthy();
    expect(screen.queryByText(/Switching accounts clears/u)).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.change(field, { target: { value: ' +15550199 ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
    });
    expect(screen.getByText(/Switching accounts clears/u)).toBeTruthy();
  });
});

describe('Settings → Connection, browser build', () => {
  it('has no desktop rows and asks for a daemon address instead', async () => {
    snowdrop = await bootSnowdrop();
    expect(snowdrop.desktop).toBeNull();
    renderWithSnowdrop(snowdrop, <ConnectionPage />);

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'signal-cli' }));
    });
    await settle(snowdrop);

    expect(screen.queryByText('Run signal-cli')).toBeNull();
    expect(screen.getByLabelText('Daemon address')).toBeTruthy();
    expect(screen.getByText(/same-origin proxy path/u)).toBeTruthy();
  });

  it('reports a failed test connection with plain copy, raw detail only behind "Details"', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConnectionPage />);

    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'signal-cli' }));
    });
    await settle(snowdrop);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });

    // Nothing is listening on the daemon address in this test environment,
    // so the probe always fails; only the mapped copy may appear inline.
    const details = await screen.findByText('Details', {}, { timeout: 3000 });
    expect(screen.queryByText(/Failed to fetch|ECONNREFUSED|TypeError/u)).toBeNull();
    expect(details.closest('details')).toBeTruthy();
  });
});

describe('Settings → Connection, browser build: switching signal-cli accounts', () => {
  async function bootSignalCliSnowdrop(account: string): Promise<Snowdrop> {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account } },
      }),
    });
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', []);
    const s = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    await act(async () => {
      await s.start();
      await flush();
    });
    return s;
  }

  it('clears this computer’s cached history before reloading, with a note in the confirm dialog', async () => {
    snowdrop = await bootSignalCliSnowdrop(SELF_ACI);
    const clearHistory = vi.spyOn(snowdrop.admin, 'clearHistory');
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      renderWithSnowdrop(snowdrop, <ConnectionPage />);

      act(() => {
        fireEvent.change(screen.getByLabelText('Account'), {
          target: { value: 'a-different-account' },
        });
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
      });
      expect(
        await screen.findByText(/Switching accounts clears this computer.s cached history/u),
      ).toBeTruthy();

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
      });
      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1);
      });
      expect(clearHistory).toHaveBeenCalledTimes(1);
      // Cleared before the reload that would otherwise show it under the new account.
      expect(clearHistory.mock.invocationCallOrder[0]).toBeLessThan(
        reload.mock.invocationCallOrder[0]!,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not clear history when nothing about the account or daemon changed', async () => {
    snowdrop = await bootSignalCliSnowdrop(SELF_ACI);
    const clearHistory = vi.spyOn(snowdrop.admin, 'clearHistory');
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      renderWithSnowdrop(snowdrop, <ConnectionPage />);

      // Switching to the demo and back doesn't touch the account/daemon fields.
      act(() => {
        fireEvent.click(screen.getByRole('radio', { name: 'Demo' }));
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
      });
      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1);
      });
      expect(clearHistory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the draft unsaved, shows the error, and clears again on retry when the clear fails', async () => {
    snowdrop = await bootSignalCliSnowdrop(SELF_ACI);
    const { settings } = snowdrop.stores;
    const clearHistory = vi
      .spyOn(snowdrop.admin, 'clearHistory')
      .mockRejectedValueOnce(new Error('IDB is busy'))
      .mockResolvedValue(undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      renderWithSnowdrop(snowdrop, <ConnectionPage />);
      act(() => {
        fireEvent.change(screen.getByLabelText('Account'), {
          target: { value: 'a-different-account' },
        });
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Reload now' }));
        await Promise.resolve();
      });

      expect((await screen.findByRole('alert')).textContent).toContain('IDB is busy');
      expect(reload).not.toHaveBeenCalled();
      // Nothing was saved, so the retry still sees an account switch.
      expect(settings.getState().connection.account).toBe(SELF_ACI);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reload now' }).disabled).toBe(
        false,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1);
      });
      expect(clearHistory).toHaveBeenCalledTimes(2);
      expect(settings.getState().connection.account).toBe('a-different-account');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads to reconnect when the user cancels after a failed clear stopped syncing', async () => {
    snowdrop = await bootSignalCliSnowdrop(SELF_ACI);
    vi.spyOn(snowdrop.admin, 'clearHistory').mockRejectedValue(new Error('IDB is busy'));
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      renderWithSnowdrop(snowdrop, <ConnectionPage />);
      act(() => {
        fireEvent.change(screen.getByLabelText('Account'), {
          target: { value: 'a-different-account' },
        });
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Reload now' }));
        await Promise.resolve();
      });
      expect((await screen.findByRole('alert')).textContent).toContain('stopped syncing');
      expect(reload).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel and reconnect' }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1);
      });
      // The old account is still the saved one.
      expect(snowdrop.stores.settings.getState().connection.account).toBe(SELF_ACI);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the error and re-enables the dialog when the reload itself fails', async () => {
    snowdrop = await bootSignalCliSnowdrop(SELF_ACI);
    vi.spyOn(snowdrop.admin, 'reload').mockRejectedValue(new Error('disk full'));
    renderWithSnowdrop(snowdrop, <ConnectionPage />);
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Demo' }));
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and reload' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Reload now' }));
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reload now' }).disabled).toBe(
      false,
    );
  });
});

describe('Settings → Connection: sync contacts and groups', () => {
  async function bootConnectedSignalCli(daemon: FakeDaemon): Promise<Snowdrop> {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: {
          connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: SELF_ACI },
        },
      }),
    });
    const s = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    await act(async () => {
      await s.start();
      await flush();
    });
    return s;
  }

  it('is hidden for the demo backend', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConnectionPage />);
    expect(screen.queryByText('Sync contacts and groups')).toBeNull();
  });

  it('calls sendSyncRequest, then re-lists, with busy/done states', async () => {
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', [])
      .reply('sendSyncRequest', {});
    snowdrop = await bootConnectedSignalCli(daemon);
    renderWithSnowdrop(snowdrop, <ConnectionPage />);

    const button = screen.getByRole('button', { name: 'Sync now' });
    act(() => {
      fireEvent.click(button);
    });
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Synced' })).toBeTruthy();
    });
    expect(daemon.callsTo('sendSyncRequest')).toHaveLength(1);
  });

  it('shows an error toast when the sync request fails', async () => {
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', [])
      .handle('sendSyncRequest', () => ({ error: { code: -1, message: 'no primary device' } }));
    snowdrop = await bootConnectedSignalCli(daemon);
    renderWithSnowdrop(snowdrop, <ConnectionPage />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    });
    // No <Toaster/> is mounted by renderWithSnowdrop; the toast store is the
    // source of truth that an error toast (not a crash) was raised.
    await waitFor(() => {
      expect(snowdrop!.stores.ui.getState().toasts).toEqual([
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('Sync failed') as unknown,
        }),
      ]);
    });
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });
});
