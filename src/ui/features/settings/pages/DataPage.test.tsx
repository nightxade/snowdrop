/**
 * Settings → Data & storage → Diagnostics: the verbose-logging switch
 * (persisted in `behaviour.verboseLogging`) and the copy/open-folder
 * actions. `bootSnowdrop` boots a real (browser/demo) Snowdrop, so
 * `app.logs` is null by default — the desktop path is exercised by
 * swapping in a fake `LogAdmin` after boot.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { createLogger, type LogAdmin } from '@/core/lib';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { DataPage } from './DataPage';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

/**
 * Plain `vi.fn()` spies, not typed through `LogAdmin` (whose methods use
 * interface shorthand): asserting on `admin.recent` etc. directly would
 * trip `@typescript-eslint/unbound-method` the way `expect(admin.x)` would
 * (see EncryptionSection.test.tsx's `makeSpies` for the same pattern).
 */
function fakeLogAdmin(overrides: Partial<LogAdmin> = {}) {
  const base = {
    recent: vi.fn(() => Promise.resolve('desktop log tail')),
    setVerbose: vi.fn(() => Promise.resolve()),
    openFolder: vi.fn(),
  };
  return { ...base, ...overrides } as typeof base;
}

describe('Settings → Data & storage → Diagnostics', () => {
  it('is off by default and flips behaviour.verboseLogging when toggled', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);

    expect(snowdrop.stores.settings.getState().behaviour.verboseLogging).toBe(false);
    const toggle = screen.getByRole('switch', { name: 'Verbose logging' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.verboseLogging).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('copies the in-memory ring buffer to the clipboard in the browser build', async () => {
    snowdrop = await bootSnowdrop();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    createLogger('data-page-test').info('a marker line for the ring buffer test');

    renderWithSnowdrop(snowdrop, <DataPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('a marker line for the ring buffer test');
    await waitFor(() => {
      expect(screen.getByText('Copied.')).toBeTruthy();
    });
  });

  it('shows a quiet error note when the clipboard write fails', async () => {
    snowdrop = await bootSnowdrop();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderWithSnowdrop(snowdrop, <DataPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('Could not copy the log.')).toBeTruthy();
    });
  });

  it('has no "Open log folder" row in the browser build (app.logs is null)', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('on desktop, copies the on-disk log and can open the log folder', async () => {
    snowdrop = await bootSnowdrop();
    const admin = fakeLogAdmin();
    snowdrop.logs = admin;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderWithSnowdrop(snowdrop, <DataPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(admin.recent).toHaveBeenCalledWith(65536);
    expect(writeText).toHaveBeenCalledWith('desktop log tail');

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(admin.openFolder).toHaveBeenCalledTimes(1);
  });
});
