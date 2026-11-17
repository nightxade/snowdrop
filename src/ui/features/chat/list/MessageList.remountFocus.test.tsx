/**
 * The list remounts its scroller when its window is replaced (epoch). Focus that was in the list
 * goes to the new tab stop however long the load took; focus that moved elsewhere is left alone.
 */
import { act, cleanup, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messageId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessagePane } from '../MessagePane';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function mounted() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  const author = conv.memberIds[0]!;
  const make = (at: number): Message => ({
    id: messageId(author, at),
    conversationId: conv.id,
    authorId: author,
    sentAt: at,
    receivedAt: at,
    body: `message ${at}`,
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  });
  const flags = { hasMoreBefore: false, hasMoreAfter: false };
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
    snowdrop.stores.messages.getState().replaceWindow(conv.id, [make(5_000_000)], flags);
  });
  const input = document.createElement('input');
  document.body.appendChild(input);
  renderWithSnowdrop(
    snowdrop,
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
      <ChatControllerProvider value={new ChatController()}>
        <MessagePane conversationId={conv.id} />
      </ChatControllerProvider>
    </VirtuosoMockContext.Provider>,
  );
  await settle(snowdrop);
  const scroller = () => document.querySelector<HTMLElement>('[data-message-scroller]')!;
  const replace = (at: number) => {
    snowdrop.stores.messages.getState().replaceWindow(conv.id, [make(at)], flags);
  };
  return { snowdrop, input, scroller, replace };
}

const inList = () => document.activeElement?.closest('[data-message-scroller]') != null;

describe('MessageList: focus through a remount', () => {
  it('hands focus to the new list when the window is replaced long after the list opened', async () => {
    const { scroller, replace } = await mounted();
    const before = scroller();
    act(() => {
      before.focus();
    });
    expect(document.activeElement).toBe(before);
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    // Far more than 60 frames pass before the messages arrive.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 200);
    });
    await act(async () => {
      replace(6_000_000);
      await vi.advanceTimersByTimeAsync(16 * 3);
    });
    expect(scroller()).not.toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 10);
    });
    expect(inList()).toBe(true);
  });

  it('does not take focus that moved to another field in the meantime', async () => {
    const { scroller, input, replace } = await mounted();
    act(() => {
      scroller().focus();
    });
    act(() => {
      input.focus();
    });
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    await act(async () => {
      replace(6_000_000);
      await vi.advanceTimersByTimeAsync(16 * 30);
    });
    expect(document.activeElement).toBe(input);
    await waitFor(() => {
      expect(scroller()).toBeTruthy();
    });
  });
});
