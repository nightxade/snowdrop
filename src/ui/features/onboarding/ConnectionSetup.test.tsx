import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAdmin } from '@/core/backend';
import { ConnectionSetup } from './ConnectionSetup';

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

describe('ConnectionSetup: not-installed (desktop, no signal-cli to run)', () => {
  it('explains the problem and takes a path once it looks valid', () => {
    const onProgramPath = vi.fn();
    render(
      <ConnectionSetup
        reason="not-installed"
        errorMessage="Snowdrop couldn’t start signal-cli."
        onProgramPath={onProgramPath}
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: /signal-cli isn.t available/u })).toBeTruthy();
    expect(screen.getByText(/Snowdrop couldn.t start signal-cli\./u)).toBeTruthy();
    expect(screen.getByText(/Linux-native/u)).toBeTruthy();

    const input = screen.getByLabelText('Path to signal-cli');
    const submit = screen.getByRole('button', { name: 'Use it' });

    // A relative path is rejected, and nothing is reported upstream.
    act(() => {
      fireEvent.change(input, { target: { value: 'signal-cli' } });
      fireEvent.blur(input);
    });
    expect(screen.getByText('Enter the full path, starting with /.')).toBeTruthy();
    act(() => {
      fireEvent.click(submit);
    });
    expect(onProgramPath).not.toHaveBeenCalled();

    // An absolute path clears the error and is reported, trimmed.
    act(() => {
      fireEvent.change(input, { target: { value: '  /usr/local/bin/signal-cli  ' } });
    });
    expect(screen.queryByText('Enter the full path, starting with /.')).toBeNull();
    act(() => {
      fireEvent.click(submit);
    });
    expect(onProgramPath).toHaveBeenCalledWith('/usr/local/bin/signal-cli');
  });

  it('falls back to generic guidance with no error message', () => {
    render(
      <ConnectionSetup
        reason="not-installed"
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByText(/Snowdrop couldn.t find signal-cli\./u)).toBeTruthy();
  });
});

describe('ConnectionSetup: not-installed, first run (desktop, nothing configured)', () => {
  it('shows the download screen instead of asking for a path, when nothing was configured', async () => {
    const onInstalled = vi.fn();
    render(
      <ConnectionSetup
        reason="not-installed"
        install={{ admin: fakeAdmin(), configured: false, onInstalled }}
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Get signal-cli' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /signal-cli isn.t available/u })).toBeNull();

    const button = await screen.findByRole('button', { name: /Download and continue/u });
    act(() => {
      fireEvent.click(button);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('still asks for a path when a configured one turned out bad', () => {
    render(
      <ConnectionSetup
        reason="not-installed"
        errorMessage="Couldn’t run /opt/bad/signal-cli."
        install={{ admin: fakeAdmin(), configured: true, onInstalled: () => undefined }}
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: /signal-cli isn.t available/u })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Get signal-cli' })).toBeNull();
  });
});

describe('ConnectionSetup: other reasons never show the missing-program screen', () => {
  it('shows the account prompt for "account-required"', () => {
    render(
      <ConnectionSetup
        reason="account-required"
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.queryByRole('heading', { name: /signal-cli isn.t available/u })).toBeNull();
  });
});
