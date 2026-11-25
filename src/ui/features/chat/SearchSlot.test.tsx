import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { SnowdropProvider } from '@/app/SnowdropProvider';
import { mergeDuplicate } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
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

  it('closes the narrow sheet when a result is picked, keeps the query, and jumps with focus', async () => {
    snowdrop = await bootSnowdrop();
    const first = Object.values(snowdrop.stores.conversations.getState().byId)[0]!.id;
    const { seq: _seq, ...incoming } = makeMessage({
      conversationId: first,
      authorId: 'ana',
      sentAt: 9_000_000_000_000,
      body: 'lunch at noon',
    });
    await snowdrop.repository.upsert(incoming, mergeDuplicate);
    const chat = new ChatController();
    const reveal = vi.spyOn(chat, 'reveal').mockResolvedValue(true);
    chat.setSearchOpen(true);
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={chat}>
        <SearchSlot conversationId={first} narrow />
      </ChatControllerProvider>,
    );
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'lunch' },
    });
    fireEvent.click(await screen.findByText('lunch at noon'));
    expect(reveal).toHaveBeenCalledWith(first, expect.anything(), { focus: true });
    expect(chat.isSearchOpen()).toBe(false);
    // Opened again, it shows the same query.
    chat.setSearchOpen(true);
    expect(chat.searchQueryFor(first)).toBe('lunch');
  });

  it('keeps the page open when a result is picked beside the chat', async () => {
    snowdrop = await bootSnowdrop();
    const first = Object.values(snowdrop.stores.conversations.getState().byId)[0]!.id;
    const { seq: _seq, ...incoming } = makeMessage({
      conversationId: first,
      authorId: 'ana',
      sentAt: 9_000_000_000_000,
      body: 'lunch at noon',
    });
    await snowdrop.repository.upsert(incoming, mergeDuplicate);
    const chat = new ChatController();
    vi.spyOn(chat, 'reveal').mockResolvedValue(true);
    chat.setSearchOpen(true);
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={chat}>
        <SearchSlot conversationId={first} narrow={false} />
      </ChatControllerProvider>,
    );
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'lunch' },
    });
    fireEvent.click(await screen.findByText('lunch at noon'));
    expect(chat.isSearchOpen()).toBe(true);
  });
});
