import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesktopAdmin, DesktopProbeResult, LocateResult } from '@/core/backend';
import { DEFAULT_DESKTOP_CONNECTION, type DesktopConnection } from '@/core/stores';
import { DesktopConnectionRows } from './DesktopConnectionRows';

afterEach(cleanup);

/** A fake signal-cli admin: no IPC, just enough behaviour to drive the rows. */
function fakeAdmin(): DesktopAdmin {
  return {
    probe: (): Promise<DesktopProbeResult> =>
      Promise.resolve({ ok: true, accounts: 1, version: '0.14.8', program: null }),
    locate: (value): Promise<LocateResult> => {
      if (value.useBundled)
        return Promise.resolve({ ok: true, path: '/opt/snowdrop/signal-cli', source: 'bundled' });
      const path = value.binaryPath.trim();
      if (!path)
        return Promise.resolve({
          ok: false,
          kind: 'not-installed',
          message: 'Nothing named signal-cli was found on your PATH.',
        });
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
        bundledSignalCli: '0.14.8',
        signalCliLicense: null,
        signalCliSource: null,
        dataDir: '/home/me/.local/share/signal-cli',
        logFile: null,
      }),
  };
}

/** The rows are a controlled component; a tiny wrapper owns the draft. */
function Controlled({ admin, initial }: { admin: DesktopAdmin; initial?: DesktopConnection }) {
  const [value, setValue] = useState<DesktopConnection>(initial ?? DEFAULT_DESKTOP_CONNECTION);
  return <DesktopConnectionRows admin={admin} value={value} onChange={setValue} />;
}

describe('DesktopConnectionRows', () => {
  it('defaults to the bundled signal-cli, managed by Snowdrop', async () => {
    render(<Controlled admin={fakeAdmin()} />);
    expect(
      screen.getByRole('radio', { name: 'Managed by Snowdrop' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      await screen.findByText(/Snowdrop will run the bundled signal-cli 0\.14\.8\./u),
    ).toBeTruthy();
    // Bundled: just a switch, no free-text path field.
    expect(screen.queryByLabelText('signal-cli path')).toBeNull();
  });

  it('shows a validation error for a path that isn’t named signal-cli', async () => {
    render(<Controlled admin={fakeAdmin()} />);
    // Wait for the bundled-signal-cli info to load; only then is there a switch to turn off.
    const toggle = await screen.findByRole('switch', { name: 'signal-cli program' });
    act(() => {
      fireEvent.click(toggle);
    });
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
