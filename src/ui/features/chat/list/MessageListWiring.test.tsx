import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messageId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessagePane } from '../MessagePane';
import { RowState } from './rowState';
import { useScrollerBinding } from './useScrollerBinding';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function openTwoMessages(snowdrop: Snowdrop) {
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  const author = conv.memberIds[0]!;
  const ids = [messageId(author, 4_000_000), messageId(author, 4_000_060)] as const;
  const messages: Message[] = ids.map((id, i) => ({
    id,
    conversationId: conv.id,
    authorId: author,
    sentAt: 4_000_000 + i * 60_000,
    receivedAt: 4_000_000 + i * 60_000,
    body: `wiring message ${i}`,
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  }));
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
    snowdrop.stores.messages
      .getState()
      .replaceWindow(conv.id, messages, { hasMoreBefore: false, hasMoreAfter: false });
  });
  const chat = new ChatController();
  renderWithSnowdrop(
    snowdrop,
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
      <ChatControllerProvider value={chat}>
        <MessagePane conversationId={conv.id} />
      </ChatControllerProvider>
    </VirtuosoMockContext.Provider>,
  );
  await settle(snowdrop);
  const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
  await waitFor(
    () => {
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
      expect(document.querySelector(`[data-message-id="${ids[1]}"]`)).toBeTruthy();
    },
    { timeout: 3000 },
  );
  return { conv, chat, scroller, ids, author };
}

describe('MessageList wiring', () => {
  it('a stale failed reveal does not clear a newer reveal target', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { conv, chat, ids, author } = await openTwoMessages(snowdrop);
    let finish!: (ok: boolean) => void;
    vi.spyOn(snowdrop.history, 'jumpTo').mockImplementation(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const missing = messageId(author, 1);
    await act(async () => {
      const stale = chat.reveal(conv.id, missing);
      // A newer reveal (already loaded) takes over, then the stale one fails.
      await chat.reveal(conv.id, ids[0], { focus: true });
      finish(false);
      await stale;
      await new Promise((r) => requestAnimationFrame(r));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(ids[0]);
  });

  it('many scroll events within one frame measure the divider at most once', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { scroller } = await openTwoMessages(snowdrop);
    const query = vi.spyOn(scroller, 'querySelector');
    const dividerQueries = () =>
      query.mock.calls.filter((c) => c[0].includes('new-divider')).length;
    query.mockClear();
    act(() => {
      for (let i = 0; i < 20; i++) scroller.dispatchEvent(new Event('scroll'));
    });
    expect(dividerQueries()).toBe(0);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(dividerQueries()).toBeLessThanOrEqual(1);
  });
});

describe('useScrollerBinding', () => {
  it('removes the scroll listener on unmount and when the element changes', () => {
    const onScroll = vi.fn();
    const { result, unmount } = renderHook(() =>
      useScrollerBinding({
        rows: new RowStateHolder().rows,
        onScroll,
        onResize: vi.fn(),
        onReaderInput: vi.fn(),
      }),
    );
    const a = document.createElement('div');
    const b = document.createElement('div');
    act(() => {
      result.current.scrollerRef(a);
    });
    a.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.scrollerRef(b);
    });
    a.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(1);
    b.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(2);
    unmount();
    b.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(2);
  });

  it('reports the reader moving the list: wheel, touch, keys and its own scroll bar, not a press on a row', () => {
    const onReaderInput = vi.fn();
    const { result, unmount } = renderHook(() =>
      useScrollerBinding({
        rows: new RowStateHolder().rows,
        onScroll: vi.fn(),
        onResize: vi.fn(),
        onReaderInput,
      }),
    );
    const list = document.createElement('div');
    const row = document.createElement('div');
    list.appendChild(row);
    act(() => {
      result.current.scrollerRef(list);
    });
    list.dispatchEvent(new Event('wheel'));
    list.dispatchEvent(new Event('touchstart'));
    row.dispatchEvent(new Event('keydown', { bubbles: true }));
    list.dispatchEvent(new Event('pointerdown'));
    expect(onReaderInput).toHaveBeenCalledTimes(4);
    row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onReaderInput).toHaveBeenCalledTimes(4);
    unmount();
    list.dispatchEvent(new Event('wheel'));
    expect(onReaderInput).toHaveBeenCalledTimes(4);
  });
});

class RowStateHolder {
  readonly rows = new RowState();
}
