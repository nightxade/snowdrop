/**
 * A sending message is swapped for its sent version (same row key, new id): the store drops the old
 * id before the virtualiser passes the row the new one. In between, the row must stay on the page
 * (and keep focus), not render nothing for a frame.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

describe('<MessageItem /> whose id has just left the store', () => {
  it('stays on the page with its focus until it is given the new id', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
    });
    const last = messagesSelectors.list(conv.id)(snowdrop.stores.messages.getState()).at(-1)!;
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={new ChatController()}>
        <div data-snowdrop="message-log">
          <MessageItem
            conversationId={conv.id}
            id={last.id}
            continuation={false}
            compact={false}
            compactAvatars={false}
          />
        </div>
      </ChatControllerProvider>,
    );
    const row = screen.getByRole('article');
    act(() => {
      row.focus();
    });
    expect(document.activeElement).toBe(row);
    act(() => {
      snowdrop.stores.messages.getState().remove(conv.id, last.id);
    });
    expect(screen.getByRole('article')).toBe(row);
    expect(document.activeElement).toBe(row);
  });
});
