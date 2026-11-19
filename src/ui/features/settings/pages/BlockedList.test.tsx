import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { Modal, trackFocusHistory } from '@/ui/primitives';
import { BlockedList } from './BlockedList';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

async function open() {
  snowdrop = await bootSnowdrop();
  const mock = (await snowdrop.backendReady) as MockBackend;
  renderWithSnowdrop(snowdrop, <BlockedList />);
  await settle(snowdrop);
  return { snowdrop, mock };
}

describe('blocked people and groups', () => {
  it('says so when no one is blocked, and axe is clean', async () => {
    await open();
    expect(screen.getByText('No one is blocked')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(
      (await axe(document.body, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('lists blocked people (even with no chat) and groups, each with Unblock that asks first', async () => {
    const { snowdrop: app, mock } = await open();
    const dm = mock.world.conversationIds.get('request-dm')!;
    const group = mock.world.conversationIds.get('request-group')!;
    const stranger = 'c0c1d2e3-0000-4000-8000-0000000000aa';
    mock.world.contacts.set(stranger, {
      id: stranger,
      name: 'Zed Nochat',
      color: '#fff',
      blocked: true,
    });
    app.stores.contacts
      .getState()
      .upsert({ id: stranger, name: 'Zed Nochat', color: '#fff', blocked: true });
    await act(async () => {
      await app.requests.block(dm);
      await app.requests.block(group);
    });
    await settle(app);
    const people = screen.getByRole('list', { name: 'People' });
    expect(within(people).getByText('Marlowe Quist')).toBeTruthy();
    expect(within(people).getByText('Zed Nochat')).toBeTruthy();
    const groups = screen.getByRole('list', { name: 'Groups' });
    expect(within(groups).getByText('Thursday Wheel Club')).toBeTruthy();
    expect(within(groups).getByText('Group, 2 members')).toBeTruthy();
    expect(
      (await axe(document.body, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);

    const setBlocked = vi.spyOn(mock, 'setBlocked');
    const button = within(people).getByRole('button', { name: 'Unblock Zed Nochat' });
    expect(button.tabIndex).toBe(0);
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Unblock Zed Nochat?' });
    expect(setBlocked).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unblock' }));
    await waitFor(() => {
      expect(setBlocked).toHaveBeenCalledTimes(1);
    });
    await settle(app);
    expect(screen.queryByText('Zed Nochat')).toBeNull();
    expect(screen.getByText('Marlowe Quist')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the unblock keeps the person listed', async () => {
    const { snowdrop: app, mock } = await open();
    const dm = mock.world.conversationIds.get('request-dm')!;
    await act(async () => {
      await app.requests.block(dm);
    });
    await settle(app);
    const setBlocked = vi.spyOn(mock, 'setBlocked');
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Marlowe Quist' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await settle(app);
    expect(setBlocked).not.toHaveBeenCalled();
    expect(screen.getByText('Marlowe Quist')).toBeTruthy();
  });

  it('unblocking inside an open dialog (Settings) keeps focus in it: next entry, else previous, else the empty state', async () => {
    snowdrop = await bootSnowdrop();
    const mock = (await snowdrop.backendReady) as MockBackend;
    const app = snowdrop;
    const stopTracking = trackFocusHistory();
    try {
      await act(async () => {
        await app.requests.block(mock.world.conversationIds.get('request-dm')!);
        await app.requests.block(mock.world.conversationIds.get('request-group')!);
      });
      renderWithSnowdrop(
        app,
        <>
          <nav data-snowdrop="sidebar">
            <button type="button" data-roving-item tabIndex={0}>
              a row behind Settings
            </button>
          </nav>
          <Modal open onOpenChange={() => undefined} title="Settings">
            <BlockedList />
          </Modal>
        </>,
      );
      await settle(app);
      const behind = document.querySelector<HTMLElement>('[data-snowdrop="sidebar"] button')!;
      act(() => {
        behind.focus();
      });
      const unblock = async (name: string) => {
        const button = screen.getByRole('button', { name });
        act(() => {
          button.focus();
        });
        fireEvent.click(button);
        const dialog = await screen.findByRole('dialog', { name: /^Unblock/u });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Unblock' }));
        await waitFor(() => {
          expect(screen.queryByRole('dialog', { name: /^Unblock/u })).toBeNull();
        });
        await settle(app);
      };
      const settings = screen.getByRole('dialog', { name: 'Settings' });
      // The person comes before the group: with the person gone, the group is next.
      await unblock('Unblock Marlowe Quist');
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Unblock Thursday Wheel Club' }),
      );
      // The last entry: the empty state, still inside Settings, never the row behind it.
      await unblock('Unblock Thursday Wheel Club');
      expect(screen.getByText('No one is blocked')).toBeTruthy();
      expect(document.activeElement).not.toBe(behind);
      expect(settings.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.hasAttribute('data-blocked-empty')).toBe(true);
    } finally {
      stopTracking();
    }
  });
});
