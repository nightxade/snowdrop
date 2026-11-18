import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { SnowdropProvider } from '@/app/SnowdropProvider';
import { TooltipProvider } from '@/ui/primitives';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from './ChatController';
import { SearchSlot } from './SearchSlot';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('<SearchSlot />', () => {
  it('keeps what was typed when the panel moves between the page and a sheet', async () => {
    snowdrop = await bootSnowdrop();
    const conversations = Object.values(snowdrop.stores.conversations.getState().byId);
    const first = conversations[0]!.id;
    const chat = new ChatController();
    const slot = (narrow: boolean) => (
      <ChatControllerProvider value={chat}>
        <SearchSlot conversationId={first} narrow={narrow} />
      </ChatControllerProvider>
    );
    const view = renderWithSnowdrop(snowdrop, slot(false));
    const field = () =>
      screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search messages' });
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'lunch' },
    });
    expect(field().value).toBe('lunch');

    for (const narrow of [true, false]) {
      view.rerender(
        <SnowdropProvider snowdrop={snowdrop}>
          <TooltipProvider>{slot(narrow)}</TooltipProvider>
        </SnowdropProvider>,
      );
      await screen.findByRole('searchbox', { name: 'Search messages' });
      expect(field().value).toBe('lunch');
    }
  });
});
