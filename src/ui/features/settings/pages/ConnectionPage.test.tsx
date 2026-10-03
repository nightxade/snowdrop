/**
 * Settings → Connection in the desktop app: a fake DesktopAdmin stands in for
 * src/platform/tauri (never loaded here), injected the way the real app does
 * it — isTauri() true, @/platform/tauri mocked — rather than mocking globals
 * the component reads directly.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAdmin, DesktopInfo, DesktopProbeResult, LocateResult } from '@/core/backend';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { createMemoryStorage } from '@/core/persistence';
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
});
