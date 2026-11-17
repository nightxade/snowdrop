/**
 * A message still sending is told apart without fading it: a "Sending" clock and the row's pending
 * mark (the muted text colour is a stylesheet rule: journeys/test_list.py :: pending_message_is_muted_with_a_clock).
 */
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { MockBackend } from '@/core/backend/mock';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

/** Sends a message in Engineering and renders its row; `settle` lets the backend answer. */
async function sendAndRender(settle: boolean) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const backend = await snowdrop.backendReady;
  if (!settle && backend instanceof MockBackend) {
    // The backend never answers: the message stays pending.
    vi.spyOn(backend, 'send').mockImplementation(() => new Promise(() => undefined));
  }
  await act(async () => {
    const sending = snowdrop.send.send({
      conversationId: conv.id,
      text: 'on its way',
      mentionIds: [],
      attachments: [],
    });
    if (settle) await sending;
    else await Promise.resolve();
  });
  const selfId = snowdrop.stores.session.getState().self!.id;
  const own = messagesSelectors
    .list(conv.id)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId)!;
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={conv.id}
          id={own.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
    </ChatControllerProvider>,
  );
  return { own, row: screen.getByRole('article') };
}

describe('<MessageItem /> while sending', () => {
  it('carries a "Sending" clock and the pending mark, and is not faded', async () => {
    const { own, row } = await sendAndRender(false);
    expect(own.status).toBe('pending');
    expect(row.hasAttribute('data-pending')).toBe(true);
    const sending = within(row).getByText('Sending');
    expect(sending.parentElement?.querySelector('svg')).not.toBeNull();
    expect(row.style.opacity).toBe('');
    expect(
      row.querySelector('[data-snowdrop="message-body"]')?.getAttribute('style') ?? '',
    ).not.toMatch(/opacity/u);
  });

  it('loses both once the backend has taken the message', async () => {
    const { own, row } = await sendAndRender(true);
    expect(own.status).not.toBe('pending');
    expect(row.hasAttribute('data-pending')).toBe(false);
    expect(within(row).queryByText('Sending')).toBeNull();
  });
});
