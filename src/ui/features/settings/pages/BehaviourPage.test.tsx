import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopInfo } from '@/core/backend';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { BehaviourPage } from './BehaviourPage';

const DESKTOP_INFO: DesktopInfo = {
  managedSignalCli: null,
  signalCliReleaseUrl: null,
  signalCliLicense: null,
  signalCliSource: null,
  dataDir: '',
  logFile: null,
  trayAvailable: true,
};

/** Simulates the desktop build's `DesktopAdmin` far enough for `info()` — the row's own fetch doesn't care about anything else on it. */
function fakeDesktopInfo(info: DesktopInfo): { info: () => Promise<DesktopInfo> } {
  return { info: () => Promise.resolve(info) };
}

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('Settings → Behaviour: focus the message box', () => {
  it('is off by default and flips the setting when toggled', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <BehaviourPage />);

    expect(snowdrop.stores.settings.getState().behaviour.focusComposerOnOpen).toBe(false);
    const toggle = screen.getByRole('switch', {
      name: 'Focus the message box when opening a conversation',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.focusComposerOnOpen).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Settings → Behaviour: link previews', () => {
  it('is not offered when the backend has no link_preview_fetch (the browser build)', async () => {
    snowdrop = await bootSnowdrop();
    expect(snowdrop.linkPreviewFetch).toBeNull();
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    expect(screen.queryByRole('switch', { name: 'Link previews' })).toBeNull();
  });

  it('is on by default and flips the setting when offered (desktop)', async () => {
    snowdrop = await bootSnowdrop();
    // Simulates the desktop build, where createSnowdrop wires this up to a
    // real fetch — the row's presence and the switch itself don't care which.
    (snowdrop as { linkPreviewFetch: unknown }).linkPreviewFetch = () => Promise.resolve(undefined);
    renderWithSnowdrop(snowdrop, <BehaviourPage />);

    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(true);
    const toggle = screen.getByRole('switch', { name: 'Link previews' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

describe('Settings → Behaviour: link previews follow the phone', () => {
  const phone = (linkPreviews: boolean | null) => ({
    readReceipts: null,
    typingIndicators: null,
    linkPreviews,
    unidentifiedDeliveryIndicators: null,
  });

  it('shows the phone’s value and writes a change back to it, not to the local setting', async () => {
    snowdrop = await bootSnowdrop();
    (snowdrop as { linkPreviewFetch: unknown }).linkPreviewFetch = () => Promise.resolve(undefined);
    const update = vi.spyOn(snowdrop.sync, 'updatePhonePrivacy').mockResolvedValue(true);
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    act(() => {
      snowdrop!.stores.session
        .getState()
        .setPhonePrivacy({ status: 'ready', values: phone(false) });
    });

    // The local setting is on; the phone's is off, and that is what shows.
    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(true);
    const toggle = screen.getByRole('switch', { name: 'Link previews' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toContain('Synced with your phone');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith({ linkPreviews: true });
    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(true);
  });

  it('is disabled until the phone has been asked', async () => {
    snowdrop = await bootSnowdrop();
    (snowdrop as { linkPreviewFetch: unknown }).linkPreviewFetch = () => Promise.resolve(undefined);
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    act(() => {
      snowdrop!.stores.session
        .getState()
        .setPhonePrivacy({ status: 'pending', values: phone(null) });
    });
    const toggle = screen.getByRole('switch', { name: 'Link previews' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

describe('Settings → Behaviour: keep running in the tray', () => {
  it('is not offered when there is no desktop admin (the browser build)', async () => {
    snowdrop = await bootSnowdrop();
    expect(snowdrop.desktop).toBeNull();
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    expect(
      screen.queryByRole('switch', { name: 'Keep running in the tray when the window is closed' }),
    ).toBeNull();
  });

  it('is not offered when the desktop build has no tray (trayAvailable: false)', async () => {
    snowdrop = await bootSnowdrop();
    (snowdrop as { desktop: unknown }).desktop = fakeDesktopInfo({
      ...DESKTOP_INFO,
      trayAvailable: false,
    });
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    // Lets `desktop.info()` (a resolved promise, but still a microtask)
    // settle before asserting the row never appears — otherwise this would
    // pass trivially before the effect even runs.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByRole('switch', { name: 'Keep running in the tray when the window is closed' }),
    ).toBeNull();
  });

  it('is on by default and flips the setting when offered (desktop with a tray)', async () => {
    snowdrop = await bootSnowdrop();
    (snowdrop as { desktop: unknown }).desktop = fakeDesktopInfo(DESKTOP_INFO);
    renderWithSnowdrop(snowdrop, <BehaviourPage />);

    const toggle = await screen.findByRole('switch', {
      name: 'Keep running in the tray when the window is closed',
    });
    expect(snowdrop.stores.settings.getState().behaviour.closeToTray).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.closeToTray).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
