import { useRef } from 'react';
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { useHistoryRead } from './useHistoryRead';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const snowdrop of snowdrops.splice(0)) await snowdrop.dispose();
});
function Probe({ message }: { message: Message }) {
  const row = useRef<HTMLDivElement>(null);
  useHistoryRead(row, message);
  return <div ref={row}>Imported message</div>;
}

describe('history read visibility', () => {
  it('waits for both focus and actual intersection, and ignores stale observer callbacks', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conversationId = Object.keys(
      snowdrop.stores.conversations.getState().byId,
    )[0] as ConversationId;
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const read = vi.spyOn(snowdrop.sync, 'readHistoryMessages').mockResolvedValue();
    const message: Message = {
      id: messageId('author', 1),
      conversationId,
      authorId: 'author',
      sentAt: 1,
      receivedAt: 1,
      body: 'old',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
      historyCursor: 'snapshot:3',
      expiresAfterReadMs: 5000,
    };
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(conversationId);
      snowdrop.stores.ui.getState().setWindowFocused(false);
    });
    renderWithSnowdrop(snowdrop, <Probe message={message} />);
    expect(callbacks).toHaveLength(0);
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(true);
    });
    expect(read).not.toHaveBeenCalled();
    const visible = (isIntersecting: boolean) => {
      callbacks[0]!(
        [
          {
            isIntersecting,
            intersectionRatio: isIntersecting ? 0.5 : 0,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    };
    act(() => {
      visible(false);
    });
    expect(read).not.toHaveBeenCalled();
    act(() => {
      visible(true);
    });
    expect(read).toHaveBeenCalledWith(conversationId, [message.id]);
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(false);
      visible(true);
    });
    // React effect cleanup follows the update; test the callback after it completes.
    const count = read.mock.calls.length;
    act(() => {
      visible(true);
    });
    expect(read).toHaveBeenCalledTimes(count);
  });
});
