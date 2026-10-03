import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesktopAdmin, DesktopProbeResult, InstallStatus, LocateResult } from '@/core/backend';
import { DEFAULT_DESKTOP_CONNECTION, type DesktopConnection } from '@/core/stores';
import { DesktopConnectionRows } from './DesktopConnectionRows';

afterEach(cleanup);

/** A fake signal-cli admin: no IPC, just enough behaviour to drive the rows. */
function fakeAdmin(overrides: Partial<DesktopAdmin> = {}): DesktopAdmin {
  return {
    probe: (): Promise<DesktopProbeResult> =>
      Promise.resolve({ ok: true, accounts: 1, version: '0.14.8', program: null }),
    locate: (value): Promise<LocateResult> => {
      const path = value.binaryPath.trim();
      if (!path) return Promise.resolve({ ok: true, path: '/data/signal-cli/0.14.8/signal-cli', source: 'downloaded' });
      if (!path.endsWith('signal-cli'))
        return Promise.resolve({
          ok: false,
          kind: 'config',
          message: 'That file isn’t named signal-cli.',
        });
      return Promise.resolve({ ok: true, path, source: 'configured' });
    },
    info: () =>
      Promise.resolve({
        managedSignalCli: '0.14.8',
        signalCliReleaseUrl: 'https://github.com/AsamK/signal-cli/releases/tag/v0.14.8',
        signalCliLicense: null,
        signalCliSource: null,
        dataDir: '/home/me/.local/share/signal-cli',
        logFile: null,
      }),
    pinnedRelease: () =>
      Promise.resolve({
        version: '0.14.8',
        repo: 'https://github.com/AsamK/signal-cli',
        assetName: 'signal-cli-0.14.8-Linux-native.tar.gz',
        downloadSizeBytes: 114_000_000,
      }),
    installStatus: (): Promise<InstallStatus> =>
      Promise.resolve({ installed: true, version: '0.14.8', path: '/data/signal-cli/0.14.8/signal-cli' }),
    install: () =>
      Promise.resolve({
        ok: true,
        status: { installed: true, version: '0.14.8', path: '/data/signal-cli/0.14.8/signal-cli' },
      }),
    cancelInstall: () => Promise.resolve(),
    ...overrides,
  };
}

/** The rows are a controlled component; a tiny wrapper owns the draft. */
function Controlled({ admin, initial }: { admin: DesktopAdmin; initial?: DesktopConnection }) {
  const [value, setValue] = useState<DesktopConnection>(initial ?? DEFAULT_DESKTOP_CONNECTION);
  return <DesktopConnectionRows admin={admin} value={value} onChange={setValue} />;
}

describe('DesktopConnectionRows', () => {
  it('shows the downloaded signal-cli version and path', async () => {
    render(<Controlled admin={fakeAdmin()} />);
    expect(
      await screen.findByText(/signal-cli 0\.14\.8 — \/data\/signal-cli\/0\.14\.8\/signal-cli/u),
    ).toBeTruthy();
    expect(
      await screen.findByText(/Snowdrop will run the signal-cli Snowdrop downloaded\./u),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-download' })).toBeTruthy();
  });

  it('downloads signal-cli again on request', async () => {
    let resolveInstall: (() => void) | null = null;
    const admin = fakeAdmin({
      install: () =>
        new Promise((resolve) => {
          resolveInstall = () => {
            resolve({ ok: true, status: { installed: true, version: '0.14.9', path: '/x/signal-cli' } });
          };
        }),
    });
    render(<Controlled admin={admin} />);
    const button = await screen.findByRole('button', { name: 'Re-download' });
    act(() => {
      fireEvent.click(button);
    });
    expect(screen.getByText('Downloading…')).toBeTruthy();
    await act(async () => {
      resolveInstall?.();
      await Promise.resolve();
    });
    expect(await screen.findByText(/signal-cli 0\.14\.9/u)).toBeTruthy();
  });

  it('reports a failed download', async () => {
    const admin = fakeAdmin({
      install: () => Promise.resolve({ ok: false, kind: 'unreachable', message: "Couldn't reach github.com." }),
    });
    render(<Controlled admin={admin} />);
    const button = await screen.findByRole('button', { name: 'Re-download' });
    act(() => {
      fireEvent.click(button);
    });
    expect(await screen.findByText("Couldn't reach github.com.")).toBeTruthy();
  });

  it('shows a validation error for a custom path that isn’t named signal-cli', async () => {
    render(<Controlled admin={fakeAdmin()} />);
    const input = await screen.findByLabelText('signal-cli path');
    act(() => {
      fireEvent.change(input, { target: { value: '/usr/local/bin/other-tool' } });
    });
    expect(
      await screen.findByText('That file isn’t named signal-cli.', {}, { timeout: 1000 }),
    ).toBeTruthy();

    act(() => {
      fireEvent.change(input, { target: { value: '/usr/local/bin/signal-cli' } });
    });
    expect(
      await screen.findByText(/Snowdrop will run \/usr\/local\/bin\/signal-cli\./u, {}, {
        timeout: 1000,
      }),
    ).toBeTruthy();
  });

  it('switches to an external daemon and asks for its loopback address', () => {
    render(<Controlled admin={fakeAdmin()} />);
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'External daemon' }));
    });
    expect(screen.getByText(/Only loopback addresses are allowed/u)).toBeTruthy();
    expect(screen.getByDisplayValue(DEFAULT_DESKTOP_CONNECTION.externalUrl)).toBeTruthy();
  });

  it('runs the test-connection probe and reports the result', async () => {
    render(<Controlled admin={fakeAdmin()} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    expect(
      await screen.findByText(/signal-cli 0\.14\.8 .*works, with 1 account\./u),
    ).toBeTruthy();
  });
});
