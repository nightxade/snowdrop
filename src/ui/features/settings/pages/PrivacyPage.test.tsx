/**
 * Settings → Privacy & security: the encryption controls only show up in
 * the desktop build (`app.storageAdmin`), the same way `ConnectionPage`
 * only shows `DesktopConnectionRows` when `app.desktop` is set. A fake
 * `StorageAdmin` stands in for src/platform/tauri (never loaded here),
 * injected the way the real app does it — isTauri() true, @/platform/tauri
 * mocked — in the style of ConnectionPage.test.tsx.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { createMemoryStorage } from '@/core/persistence';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { PrivacyPage } from './PrivacyPage';

const status: StorageStatus = {
  state: 'unlocked',
  reason: null,
  hasRecovery: false,
  hasPassphrase: false,
  hasKeyring: true,
  keyringBackend: 'secret-service',
  legacyPlaintext: false,
  vaultDisabled: false,
  restartRequired: false,
};

function fakeStorageAdmin(): StorageAdmin {
  return {
    status: () => Promise.resolve(status),
    keyringStatus: () =>
      Promise.resolve({ available: true, hasSecret: true, backend: 'secret-service' }),
    setup: () => Promise.resolve(status),
    unlock: () => Promise.resolve(status),
    createRecovery: () => Promise.resolve({ code: 'AAAA', status }),
    removeRecovery: () => Promise.resolve(status),
    setPassphrase: () => Promise.resolve(status),
    enrollKeyring: () => Promise.resolve(status),
    webcacheKey: () => Promise.resolve('AAAA'),
    eraseAll: () => Promise.resolve({ status, failures: [] }),
    signOut: () => Promise.resolve(status),
    restart: () => Promise.resolve(),
  };
}

vi.mock('@/platform/tauri', () => ({ createStorageAdmin: fakeStorageAdmin }));

async function bootDesktopSnowdrop(): Promise<Snowdrop> {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
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

describe('Settings → Privacy & security', () => {
  it('shows the encryption section in the desktop build', async () => {
    snowdrop = await bootDesktopSnowdrop();
    expect(snowdrop.storageAdmin).not.toBeNull();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);

    await waitFor(() => {
      expect(screen.queryByText('Checking…')).toBeNull();
    });
    expect(screen.getByRole('heading', { name: 'Encryption' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recovery key' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Passphrase' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeTruthy();
    // The pre-existing privacy settings are still there.
    expect(screen.getByText('Send read receipts')).toBeTruthy();
  });

  it('has no encryption section outside the desktop build', async () => {
    snowdrop = await bootSnowdrop();
    expect(snowdrop.storageAdmin).toBeNull();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);

    expect(screen.queryByRole('heading', { name: 'Encryption' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Danger zone' })).toBeNull();
    expect(screen.getByText('Send read receipts')).toBeTruthy();
  });
});
