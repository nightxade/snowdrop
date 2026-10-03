/**
 * About, desktop build: the bundled signal-cli licence/source entry, driven
 * by a fake DesktopAdmin injected the way the app does it — isTauri() true,
 * @/platform/tauri mocked — not by mocking globals the component reads.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAdmin, DesktopInfo, DesktopProbeResult, LocateResult } from '@/core/backend';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { createMemoryStorage } from '@/core/persistence';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { AboutPage } from './AboutPage';

const DESKTOP_INFO: DesktopInfo = {
  bundledSignalCli: '0.14.8',
  signalCliLicense: 'GNU GENERAL PUBLIC LICENSE\nVersion 3...',
  signalCliSource: 'Exact source: https://github.com/AsamK/signal-cli/tree/v0.14.8',
  dataDir: '/home/me/.local/share/local.snowdrop.desktop/signal-cli',
  logFile: '/home/me/.local/share/local.snowdrop.desktop/logs/signal-cli.log',
};

function fakeDesktopAdmin(): DesktopAdmin {
  return {
    probe: (): Promise<DesktopProbeResult> =>
      Promise.resolve({ ok: true, accounts: 1, version: '0.14.8', program: null }),
    locate: (): Promise<LocateResult> =>
      Promise.resolve({ ok: true, path: '/opt/snowdrop/signal-cli', source: 'bundled' }),
    info: () => Promise.resolve(DESKTOP_INFO),
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

describe('About, desktop build', () => {
  it('shows the bundled signal-cli licence and exact source', async () => {
    snowdrop = await bootDesktopSnowdrop();
    renderWithSnowdrop(snowdrop, <AboutPage />);

    expect(
      await screen.findByText(/This app includes signal-cli 0\.14\.8, unmodified/u),
    ).toBeTruthy();
    const source = screen.getByRole('link', {
      name: /github\.com\/AsamK\/signal-cli\/tree\/v0\.14\.8/u,
    });
    expect(source.getAttribute('href')).toBe('https://github.com/AsamK/signal-cli/tree/v0.14.8');
    expect(screen.getByText(DESKTOP_INFO.dataDir)).toBeTruthy();
    const summary = screen.getByText('GNU General Public License v3 (signal-cli)');
    expect(summary.closest('details')?.textContent).toContain('Version 3');
    expect(
      screen.getByText(/ships with this app as a separate, unmodified program/u),
    ).toBeTruthy();
  });
});

describe('About, browser build', () => {
  it('has no signal-cli section', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <AboutPage />);

    expect(screen.queryByText(/This app includes signal-cli/u)).toBeNull();
    expect(screen.queryByText('GNU General Public License v3 (signal-cli)')).toBeNull();
    expect(
      screen.getByText(/which runs as a separate program on your computer; none of its code/u),
    ).toBeTruthy();
  });
});
