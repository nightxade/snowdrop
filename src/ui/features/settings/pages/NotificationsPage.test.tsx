/**
 * Settings → Notifications: the copy follows the build (desktop app or
 * browser), and the permission shown follows the service as it changes.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { DesktopAdmin } from '@/core/backend';
import type { NotificationApi, NotificationPermissionState } from '@/core/services';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { createMemoryStorage } from '@/core/persistence';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { NotificationsPage } from './NotificationsPage';

vi.mock('@/platform/tauri', () => ({ createDesktopAdmin: () => ({}) as DesktopAdmin }));

const shows = { delivered: true };

/** A notification API whose permission the test moves. */
function controllable(initial: NotificationPermissionState) {
  let permission = initial;
  const listeners = new Set<() => void>();
  const api: NotificationApi = {
    permission: () => permission,
    request: () => {
      permission = 'granted';
      return Promise.resolve(permission);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    show: () => ({ close: () => undefined, delivered: Promise.resolve(shows.delivered) }),
  };
  return {
    api,
    set: (next: NotificationPermissionState) => {
      permission = next;
      act(() => {
        for (const fn of [...listeners]) fn();
      });
    },
    listeners,
  };
}

let snowdrop: Snowdrop | null = null;

async function boot(api: NotificationApi, desktop: boolean): Promise<Snowdrop> {
  if (desktop) (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  snowdrop = createSnowdrop({
    storage: createMemoryStorage(),
    mockLatencyMs: 0,
    notificationApi: api,
  });
  snowdrop.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await act(async () => {
    await snowdrop!.start();
    await snowdrop!.sync.idle();
  });
  renderWithSnowdrop(snowdrop, <NotificationsPage onNavigate={() => undefined} />);
  await settle(snowdrop);
  return snowdrop;
}

afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('Settings → Notifications in the desktop app', () => {
  it('speaks of the system, not a browser, in every permission state', async () => {
    const control = controllable('default');
    await boot(control.api, true);
    expect(screen.getByText(/needs your system’s permission/u)).toBeTruthy();
    expect(screen.getByText(/shown by your system while Snowdrop is running/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/browser/iu);

    control.set('denied');
    expect(screen.getByText('Blocked by your system.')).toBeTruthy();
    expect(screen.getByText(/system’s notification settings, then come back here/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/browser|reload|site settings/iu);

    control.set('unsupported');
    expect(screen.getByText('Desktop notifications aren’t available on this system.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/browser/iu);
  });

  it('corrects itself when the platform finishes loading and says the permission is granted', async () => {
    const control = controllable('default');
    await boot(control.api, true);
    expect(screen.getByRole('button', { name: 'Allow notifications' })).toBeTruthy();
    control.set('granted');
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeTruthy();
    expect(screen.getByText(/^Allowed\./u)).toBeTruthy();
  });

  it('looks again when the window is focused, for a change nobody announced', async () => {
    const control = controllable('default');
    await boot(control.api, true);
    // Changed in the system's settings, with no event from the app.
    await control.api.request();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeTruthy();
  });

  it('shows the new permission after Allow notifications is pressed, and stops listening on leaving', async () => {
    const control = controllable('default');
    await boot(control.api, true);
    expect(control.listeners.size).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send a test' })).toBeTruthy();
    });
    cleanup();
    expect(control.listeners.size).toBe(0);
  });

  it('has no axe violations', async () => {
    const control = controllable('denied');
    await boot(control.api, true);
    expect(
      (await axe(document.body, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });
});

describe('Settings → Notifications: the test notification', () => {
  const send = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
      await Promise.resolve();
    });
  };

  it('names a missing notification service only when the platform call failed', async () => {
    shows.delivered = false;
    const control = controllable('granted');
    await boot(control.api, true);
    await send();
    expect(await screen.findByText(/No notification service answered/u)).toBeTruthy();
  });

  it('says nothing about a service when the test worked', async () => {
    shows.delivered = true;
    const control = controllable('granted');
    await boot(control.api, true);
    await send();
    expect(await screen.findByText(/^Sent\./u)).toBeTruthy();
    expect(screen.queryByText(/notification service/u)).toBeNull();
  });
});

describe('Settings → Notifications in the browser', () => {
  it('keeps the browser wording', async () => {
    const control = controllable('denied');
    await boot(control.api, false);
    expect(screen.getByText('Blocked by your browser.')).toBeTruthy();
    expect(screen.getByText(/browser’s site settings/u)).toBeTruthy();
    expect(screen.getByText(/shown by your browser while Snowdrop is open in a tab/u)).toBeTruthy();
  });
});
