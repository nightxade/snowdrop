import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { PluginsPage } from './PluginsPage';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('article') as HTMLElement;

describe('Plugin card: runtime errors', () => {
  it('shows a failing hover action on the card, and Retry restarts the plugin', async () => {
    snowdrop = await bootSnowdrop();
    await act(async () => {
      await snowdrop!.plugins.setEnabled('message-tools', true);
    });
    renderWithSnowdrop(snowdrop, <PluginsPage />);
    const action = snowdrop.registries.hoverActions
      .list()
      .find((a) => a.owner === 'message-tools')!;
    // What HoverBar does when the button is clicked.
    act(() => {
      snowdrop!.registries.invoke(action, 'hover action', () => {
        throw new Error('copy exploded');
      });
    });
    const alert = within(card('Message Tools')).getByRole('alert');
    expect(alert.textContent).toContain(`hover action "${action.id}"`);
    expect(alert.textContent).toContain('copy exploded');
    act(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    await settle(snowdrop);
    expect(snowdrop.plugins.get('message-tools')?.status).toBe('running');
    expect(within(card('Message Tools')).queryByRole('alert')).toBeNull();
  });
});
