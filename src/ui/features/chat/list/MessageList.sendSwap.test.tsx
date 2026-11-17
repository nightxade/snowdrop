/**
 * A message still sending is replaced by its sent version when the send
 * completes (same nonce, new id). Focus on its row, and the roving tab stop,
 * must move to the new row instead of dropping to the page.
 */
import { act, cleanup, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messageId, pendingMessageId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessagePane } from '../MessagePane';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

describe('MessageList: a sent message replacing its pending row', () => {
  it('keeps the tab stop and focus on the message when its id changes', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
    const author = conv.memberIds[0]!;
    const self = snowdrop.stores.session.getState().self!.id;
    const make = (id: Message['id'], sentAt: number, extra: Partial<Message>): Message => ({
      id,
      conversationId: conv.id,
      authorId: author,
      sentAt,
      receivedAt: sentAt,
      body: `message ${sentAt}`,
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
      ...extra,
    });
    const older = make(messageId(author, 4_000_000), 4_000_000, {});
    const nonce = 'swap';
    const pending = make(pendingMessageId(nonce), 4_000_060, {
      authorId: self,
      nonce,
      status: 'pending',
    });
    const sent = make(messageId(self, 4_000_061), 4_000_061, {
      authorId: self,
      nonce,
      status: 'sent',
    });
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
      snowdrop.stores.messages
        .getState()
        .replaceWindow(conv.id, [older, pending], { hasMoreBefore: false, hasMoreAfter: false });
    });
    renderWithSnowdrop(
      snowdrop,
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
        <ChatControllerProvider value={new ChatController()}>
          <MessagePane conversationId={conv.id} />
        </ChatControllerProvider>
      </VirtuosoMockContext.Provider>,
    );
    await settle(snowdrop);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
    await waitFor(
      () => {
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
        });
        expect(row(pending.id)).toBeTruthy();
      },
      { timeout: 3000 },
    );
    act(() => {
      row(pending.id)!.focus();
    });
    expect(document.activeElement).toBe(row(pending.id));

    await act(async () => {
      snowdrop.stores.messages
        .getState()
        .replaceWindow(conv.id, [older, sent], { hasMoreBefore: false, hasMoreAfter: false });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => {
      expect(row(sent.id)).toBeTruthy();
    });
    expect(row(sent.id)!.hasAttribute('data-current')).toBe(true);
    expect(document.activeElement).toBe(row(sent.id));
  });
});
