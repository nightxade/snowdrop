import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { ConversationView, Message } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { PinnedPopover } from './PinnedPopover';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

const pin = (body: string) => makeMessage({ authorId: 'ana', body, pinned: true });

describe('<PinnedPopover />', () => {
  it('follows the chat while open: a pinned message deleted leaves it, a new pin joins it (C14)', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!;
    const gone = pin('pinned and then deleted');
    const kept = pin('pinned and kept');
    const fresh = pin('pinned just now');
    let stored = [kept, gone];
    vi.spyOn(snowdrop.repository, 'pinned').mockImplementation(() => Promise.resolve(stored));
    const flags = { hasMoreBefore: false, hasMoreAfter: false };
    snowdrop.stores.messages.getState().replaceWindow(
      conv.id,
      [gone, kept].map((m) => ({ ...m, conversationId: conv.id })),
      flags,
    );
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={new ChatController()}>
        <PinnedPopover conversation={conv as unknown as ConversationView} />
      </ChatControllerProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pinned messages' }));
    await screen.findByText('pinned and then deleted');

    // Deleted for everyone: the repository drops its pin, the store marks it deleted.
    stored = [kept];
    act(() => {
      snowdrop.stores.messages.getState().update(conv.id, gone.id, (m): Message => ({
        ...m,
        deleted: true,
        body: '',
        pinned: false,
      }));
    });
    await vi.waitFor(() => {
      expect(screen.queryByText('pinned and then deleted')).toBeNull();
    });
    expect(screen.getByText('pinned and kept')).toBeTruthy();

    // A new pin arrives.
    stored = [fresh, kept];
    act(() => {
      snowdrop.stores.messages.getState().appendLive({ ...fresh, conversationId: conv.id });
    });
    await screen.findByText('pinned just now');

    // Unpinned: the pin leaves although the message stays.
    stored = [fresh];
    act(() => {
      snowdrop.stores.messages
        .getState()
        .update(conv.id, kept.id, (m): Message => ({ ...m, pinned: false }));
    });
    await vi.waitFor(() => {
      expect(screen.queryByText('pinned and kept')).toBeNull();
    });
  });
});
