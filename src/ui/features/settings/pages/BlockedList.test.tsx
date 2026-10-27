import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
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
});
