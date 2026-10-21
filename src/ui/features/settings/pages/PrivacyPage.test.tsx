/**
 * Settings → Privacy & security: the encryption controls only show up in
 * the desktop build (`app.storageAdmin`), the same way `ConnectionPage`
 * only shows `DesktopConnectionRows` when `app.desktop` is set. A fake
 * `StorageAdmin` stands in for src/platform/tauri (never loaded here),
 * injected the way the real app does it — isTauri() true, @/platform/tauri
 * mocked — in the style of ConnectionPage.test.tsx.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import type { PhonePrivacySettings, StorageAdmin, StorageStatus } from '@/core/backend';
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

describe('Settings → Privacy: following the phone', () => {
  const unknown: PhonePrivacySettings = {
    readReceipts: null,
    typingIndicators: null,
    linkPreviews: null,
    unidentifiedDeliveryIndicators: null,
  };
  const row = (id: string) => document.querySelector(`[data-setting="${id}"]`)!;
  const toggle = (id: string) => row(id).querySelector('button[role="switch"]')!;

  function showWith(state: {
    status: 'unsupported' | 'pending' | 'ready';
    values?: Partial<typeof unknown>;
  }) {
    act(() => {
      snowdrop!.stores.session
        .getState()
        .setPhonePrivacy({ status: state.status, values: { ...unknown, ...state.values } });
    });
  }

  it('shows the phone’s values, says they are synced, and writes changes back to the phone', async () => {
    snowdrop = await bootSnowdrop();
    const update = vi.spyOn(snowdrop.sync, 'updatePhonePrivacy').mockResolvedValue(true);
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    showWith({ status: 'ready', values: { readReceipts: false, typingIndicators: true } });

    expect(toggle('privacy.receipts').getAttribute('aria-checked')).toBe('false');
    expect(toggle('privacy.typing').getAttribute('aria-checked')).toBe('true');
    expect(row('privacy.receipts').textContent).toContain('Synced with your phone');

    // The local setting says "on"; the toggle follows the phone, and a click goes to the phone.
    expect(snowdrop.stores.settings.getState().behaviour.sendReadReceipts).toBe(true);
    await act(async () => {
      fireEvent.click(toggle('privacy.receipts'));
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith({ readReceipts: true });
    expect(snowdrop.stores.settings.getState().behaviour.sendReadReceipts).toBe(true);
  });

  it('keeps editing the local setting for a value the phone has not shared yet', async () => {
    snowdrop = await bootSnowdrop();
    const update = vi.spyOn(snowdrop.sync, 'updatePhonePrivacy');
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    showWith({ status: 'ready', values: { typingIndicators: true } });

    expect(row('privacy.receipts').textContent).toContain('hasn’t shared this setting yet');
    await act(async () => {
      fireEvent.click(toggle('privacy.receipts'));
      await Promise.resolve();
    });
    expect(update).not.toHaveBeenCalled();
    expect(snowdrop.stores.settings.getState().behaviour.sendReadReceipts).toBe(false);
  });

  it('disables the switches while the phone is being asked', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    showWith({ status: 'pending' });

    expect(toggle('privacy.receipts').hasAttribute('disabled')).toBe(true);
    expect(toggle('privacy.typing').hasAttribute('disabled')).toBe(true);
    expect(row('privacy.receipts').textContent).toContain('Checking the setting on your phone');
  });

  it('uses Snowdrop’s own setting, with no sync note, where nothing can read the phone (the demo)', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    showWith({ status: 'unsupported' });

    expect(toggle('privacy.receipts').hasAttribute('disabled')).toBe(false);
    expect(row('privacy.receipts').textContent).not.toContain('phone');
    await act(async () => {
      fireEvent.click(toggle('privacy.receipts'));
      await Promise.resolve();
    });
    expect(snowdrop.stores.settings.getState().behaviour.sendReadReceipts).toBe(false);
  });

  it('hides the display switch while the phone has read receipts off', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    showWith({ status: 'ready', values: { readReceipts: false } });

    expect(toggle('privacy.showReceipts').hasAttribute('disabled')).toBe(true);
    expect(toggle('privacy.showReceipts').getAttribute('aria-checked')).toBe('false');
    showWith({ status: 'ready', values: { readReceipts: true } });
    expect(toggle('privacy.showReceipts').hasAttribute('disabled')).toBe(false);
    expect(toggle('privacy.showReceipts').getAttribute('aria-checked')).toBe('true');
  });

  it('no longer says the setting ignores the phone', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PrivacyPage />);
    expect(document.body.textContent).not.toContain('doesn’t follow the one on your phone');
  });
});
