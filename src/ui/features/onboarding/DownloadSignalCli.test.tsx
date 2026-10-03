/**
 * Desktop app, first run: no signal-cli configured and none found anywhere.
 * A fake `DesktopAdmin` stands in for src/platform/tauri (never loaded
 * here), exercising idle → downloading (with progress) → success, and the
 * error/retry and cancel paths.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAdmin, InstallProgress, InstallResult } from '@/core/backend';
import { DownloadSignalCli } from './DownloadSignalCli';

afterEach(cleanup);

function fakeAdmin(overrides: Partial<DesktopAdmin> = {}): DesktopAdmin {
  return {
    probe: () => Promise.resolve({ ok: true, accounts: null, version: null, program: null }),
    locate: () => Promise.resolve({ ok: false, kind: 'not-installed', message: 'not found' }),
    info: () =>
      Promise.resolve({
        managedSignalCli: null,
        signalCliReleaseUrl: null,
        signalCliLicense: null,
        signalCliSource: null,
        dataDir: '',
        logFile: null,
      }),
    pinnedRelease: () =>
      Promise.resolve({
        version: '0.14.8',
        repo: 'https://github.com/AsamK/signal-cli',
        assetName: 'signal-cli-0.14.8-Linux-native.tar.gz',
        downloadSizeBytes: 114_000_000,
      }),
    installStatus: () => Promise.resolve({ installed: false, version: null, path: null }),
    install: () => Promise.resolve({ ok: true, status: { installed: true, version: '0.14.8', path: '/x' } }),
    cancelInstall: () => Promise.resolve(),
    ...overrides,
  };
}

describe('DownloadSignalCli: idle', () => {
  it('names the version, source and size, with a download button', async () => {
    render(<DownloadSignalCli admin={fakeAdmin()} onInstalled={() => undefined} />);
    expect(
      await screen.findByText(/signal-cli 0\.14\.8 from github\.com\/AsamK\/signal-cli \(about 114 MB\)/u),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download and continue/u })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('DownloadSignalCli: progress', () => {
  it('shows a progress bar with aria values as bytes arrive, and can cancel', async () => {
    let onProgress: ((p: InstallProgress) => void) | null = null;
    const cancelInstall = vi.fn().mockResolvedValue(undefined);
    const admin = fakeAdmin({
      install: (progress) => {
        onProgress = progress;
        return new Promise(() => {
          // never resolves in this test: we only check the in-flight UI
        });
      },
      cancelInstall,
    });
    render(<DownloadSignalCli admin={admin} onInstalled={() => undefined} />);
    const button = await screen.findByRole('button', { name: /Download and continue/u });
    act(() => {
      fireEvent.click(button);
    });

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');

    act(() => {
      onProgress?.({ received: 50_000_000, total: 100_000_000 });
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50000000');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('100000000');

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => {
      fireEvent.click(cancel);
    });
    expect(cancelInstall).toHaveBeenCalledTimes(1);
  });

  it('is indeterminate until a total is known', () => {
    const admin = fakeAdmin({ install: () => new Promise(() => {}) });
    render(<DownloadSignalCli admin={admin} onInstalled={() => undefined} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Download and continue/u }));
    });
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.getAttribute('aria-valuetext')).toBe('Downloading…');
  });
});

describe('DownloadSignalCli: error and retry', () => {
  it('shows a clear message for no network, and retries', async () => {
    let attempt = 0;
    const install = vi.fn((): Promise<InstallResult> => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ ok: false, kind: 'unreachable', message: "Couldn't reach github.com." })
        : Promise.resolve({ ok: true, status: { installed: true, version: '0.14.8', path: '/x' } });
    });
    const onInstalled = vi.fn();
    const admin = fakeAdmin({ install });
    render(<DownloadSignalCli admin={admin} onInstalled={onInstalled} />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Download and continue/u }));
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn.t reach github\.com\. Check your connection/u)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/u }));
    });
    expect(install).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('explains a checksum mismatch in plain language', async () => {
    const admin = fakeAdmin({
      install: () =>
        Promise.resolve({
          ok: false,
          kind: 'config',
          message: 'The download didn’t match what Snowdrop expected (checksum mismatch: expected a, got b).',
        }),
    });
    render(<DownloadSignalCli admin={admin} onInstalled={() => undefined} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Download and continue/u }));
    });
    expect(await screen.findByText(/a checksum mismatch/u)).toBeTruthy();
  });
});

describe('DownloadSignalCli: success', () => {
  it('continues straight on, with no extra screen', async () => {
    const onInstalled = vi.fn();
    render(
      <DownloadSignalCli
        admin={fakeAdmin({
          install: () => Promise.resolve({ ok: true, status: { installed: true, version: '0.14.8', path: '/x' } }),
        })}
        onInstalled={onInstalled}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Download and continue/u }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });
});
