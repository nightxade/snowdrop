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
import type { StorageAdmin } from '@/core/backend';
import { createLogger, type LogAdmin } from '@/core/lib';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { downloadBytes, downloadText } from '../download';
import { DataPage } from './DataPage';

vi.mock('../download', () => ({ downloadBytes: vi.fn(), downloadText: vi.fn() }));

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

describe('Settings → Data & storage → Message history import', () => {
  it('is hidden while there is nothing to import (the demo backend)', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);

    expect(screen.queryByText('Message history import')).toBeNull();
  });

  it('shows progress while importing', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);

    act(() => {
      snowdrop?.stores.session
        .getState()
        .setHistoryImport({ status: 'importing', percent: 37, imported: 10, error: null });
    });

    expect(screen.getByText('Message history import')).toBeTruthy();
    expect(screen.getByText(/37% so far/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Importing message history' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('reports the message count once done', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);

    act(() => {
      snowdrop?.stores.session
        .getState()
        .setHistoryImport({ status: 'done', percent: 100, imported: 1234, error: null });
    });

    expect(screen.getByText(/1,234 messages/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the error and retries through HistoryImportService on failure', async () => {
    snowdrop = await bootSnowdrop();
    const retry = vi.fn().mockResolvedValue(undefined);
    // `historyImport` is a real HistoryImportService; only its action needs
    // faking here — resume/idempotency/error behaviour is covered by
    // historyImport.test.ts, and `stop()` must still work for `afterEach`'s
    // `dispose()`, so only the one method is replaced.
    snowdrop.historyImport.retry = retry;
    renderWithSnowdrop(snowdrop, <DataPage />);

    act(() => {
      snowdrop?.stores.session.getState().setHistoryImport({
        status: 'failed',
        percent: 20,
        imported: 5,
        error: 'archive unavailable',
      });
    });

    expect(screen.getByText('archive unavailable')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);

    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('Settings → Data & storage → Export history', () => {
  const openDialog = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  };
  const type = (label: string, value: string) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };
  const toasts = () => snowdrop?.stores.ui.getState().toasts.map((t) => t.message) ?? [];

  afterEach(() => {
    vi.mocked(downloadText).mockClear();
    vi.mocked(downloadBytes).mockClear();
  });

  it('warns that the file holds the messages unencrypted before writing anything', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);
    openDialog();

    expect(screen.getByRole('dialog', { name: 'Export message history' })).toBeTruthy();
    expect(screen.getByText(/anyone who has it can read them/i)).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/not a restore point/i);
    expect(downloadText).not.toHaveBeenCalled();
  });

  it('does not call the export a backup', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);
    expect(document.body.textContent).not.toMatch(/your backup/i);
  });

  it('offers only a plain export where there is no vault, behind the warning', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);
    openDialog();

    expect(screen.queryByRole('radio', { name: 'Encrypted' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export unencrypted' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(downloadText).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(downloadText).mock.calls[0]?.[0]).toMatch(/^snowdrop-history-.*\.json$/);
    expect(downloadBytes).not.toHaveBeenCalled();
  });

  describe('on desktop', () => {
    const fakeStorageAdmin = (encryptExport: StorageAdmin['encryptExport']) =>
      ({ encryptExport }) as unknown as StorageAdmin;

    it('defaults to an encrypted export and checks the passphrase first', async () => {
      snowdrop = await bootSnowdrop();
      const encryptExport = vi.fn(() => Promise.resolve(btoa('ciphertext-bytes')));
      snowdrop.storageAdmin = fakeStorageAdmin(encryptExport);
      renderWithSnowdrop(snowdrop, <DataPage />);
      openDialog();

      expect(screen.getByRole('radio', { name: 'Encrypted' }).getAttribute('aria-checked')).toBe(
        'true',
      );
      const exportButton = screen.getByRole('button', { name: 'Export encrypted' });

      // Too short, then mismatched: nothing is encrypted or written.
      type('Passphrase', 'short');
      type('Confirm passphrase', 'short');
      fireEvent.click(exportButton);
      expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
      type('Passphrase', 'long enough phrase');
      type('Confirm passphrase', 'a different phrase');
      fireEvent.click(exportButton);
      expect(screen.getByText("That doesn't match.")).toBeTruthy();
      expect(encryptExport).not.toHaveBeenCalled();
      expect(downloadBytes).not.toHaveBeenCalled();
      expect(downloadText).not.toHaveBeenCalled();

      type('Confirm passphrase', 'long enough phrase');
      await act(async () => {
        fireEvent.click(exportButton);
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => {
        expect(downloadBytes).toHaveBeenCalledTimes(1);
      });
      // The Rust command gets the passphrase and the JSON; the file is its output.
      const [passphrase, json] = encryptExport.mock.calls[0] as unknown as [string, string];
      expect(passphrase).toBe('long enough phrase');
      expect((JSON.parse(json) as { format: string }).format).toBe('snowdrop-history');
      const [fileName, bytes] = vi.mocked(downloadBytes).mock.calls[0] as [string, Uint8Array];
      expect(fileName).toMatch(/^snowdrop-history-.*\.snowdrop-export$/);
      expect(new TextDecoder().decode(bytes)).toBe('ciphertext-bytes');
      expect(downloadText).not.toHaveBeenCalled();
    });

    it('still allows an unencrypted export, and never calls the encryptor for it', async () => {
      snowdrop = await bootSnowdrop();
      const encryptExport = vi.fn(() => Promise.resolve(''));
      snowdrop.storageAdmin = fakeStorageAdmin(encryptExport);
      renderWithSnowdrop(snowdrop, <DataPage />);
      openDialog();

      fireEvent.click(screen.getByRole('radio', { name: 'Unencrypted' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Export unencrypted' }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => {
        expect(downloadText).toHaveBeenCalledTimes(1);
      });
      expect(encryptExport).not.toHaveBeenCalled();
    });

    it('writes no file and says so when encryption fails', async () => {
      snowdrop = await bootSnowdrop();
      snowdrop.storageAdmin = fakeStorageAdmin(() => Promise.reject(new Error('no crypto')));
      renderWithSnowdrop(snowdrop, <DataPage />);
      openDialog();
      type('Passphrase', 'long enough phrase');
      type('Confirm passphrase', 'long enough phrase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Export encrypted' }));
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => {
        expect(toasts().some((m) => m.startsWith('Export failed'))).toBe(true);
      });
      expect(downloadBytes).not.toHaveBeenCalled();
      expect(downloadText).not.toHaveBeenCalled();
    });
  });

  it('cancelling writes nothing', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <DataPage />);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Export message history' })).toBeNull();
    expect(downloadText).not.toHaveBeenCalled();
  });
});
