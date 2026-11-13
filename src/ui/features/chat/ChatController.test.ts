/** A jump requested for a chat that is not open applies only to the navigation it was requested with. */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationId, MessageId } from '@/core/domain';
import { ChatController, type ListHandle } from './ChatController';

const a = 'a' as ConversationId;
const b = 'b' as ConversationId;
const m = 'm' as MessageId;

function list(conversationId: ConversationId, reveal = vi.fn(() => Promise.resolve(true))) {
  return { handle: { conversationId, reveal } as unknown as ListHandle, reveal };
}

describe('ChatController pending reveal', () => {
  it('fires when the requested conversation opens', async () => {
    const chat = new ChatController();
    await chat.reveal(a, m);
    const opened = list(a);
    chat.registerList(opened.handle);
    expect(opened.reveal).toHaveBeenCalledWith(m, undefined);
  });

  it('is dropped when the user opens a different conversation first', async () => {
    const chat = new ChatController();
    await chat.reveal(a, m);
    chat.registerList(list(b).handle)();
    const later = list(a);
    chat.registerList(later.handle);
    expect(later.reveal).not.toHaveBeenCalled();
  });

  it('is consumed once, even if the reveal fails', async () => {
    const chat = new ChatController();
    await chat.reveal(a, m);
    const first = list(
      a,
      vi.fn(() => Promise.reject(new Error('gone'))),
    );
    chat.registerList(first.handle)();
    await Promise.resolve();
    const again = list(a);
    chat.registerList(again.handle);
    expect(again.reveal).not.toHaveBeenCalled();
  });
});
