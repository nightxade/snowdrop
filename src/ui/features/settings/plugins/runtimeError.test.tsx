import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Shrike } from '@/app/createShrike';
import { bootShrike, renderWithShrike, settle } from '@/test/renderWithShrike';
import { PluginsPage } from './PluginsPage';

let shrike: Shrike | null = null;
afterEach(async () => {
  cleanup();
  await shrike?.dispose();
  shrike = null;
});

const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('article') as HTMLElement;

describe('Plugin card: runtime errors', () => {
  it('shows a failing hover action on the card, and Retry restarts the plugin', async () => {
    shrike = await bootShrike();
    await act(async () => {
      await shrike!.plugins.setEnabled('message-tools', true);
    });
    renderWithShrike(shrike, <PluginsPage />);
    const action = shrike.registries.hoverActions.list().find((a) => a.owner === 'message-tools')!;
    // What HoverBar does when the button is clicked.
    act(() => {
      shrike!.registries.invoke(action, 'hover action', () => {
        throw new Error('copy exploded');
      });
    });
    const alert = within(card('Message Tools')).getByRole('alert');
    expect(alert.textContent).toContain(`hover action "${action.id}"`);
    expect(alert.textContent).toContain('copy exploded');
    act(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    await settle(shrike);
    expect(shrike.plugins.get('message-tools')?.status).toBe('running');
    expect(within(card('Message Tools')).queryByRole('alert')).toBeNull();
  });
});
