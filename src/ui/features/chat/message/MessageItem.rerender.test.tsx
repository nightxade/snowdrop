/**
 * A row re-renders on hover and focus; its body (segmented text, mentions,
 * emoji) must not be redone for that, which the memoised `MessageBody` only
 * allows while the props `MessageContent` hands it stay the same.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { memo, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import type { MessageBodyProps } from './MessageBody';
import { MessageItem } from './MessageItem';

const renders = vi.hoisted(() => ({ body: 0 }));

vi.mock('./MessageBody', async (importOriginal) => {
  const original = await importOriginal<{ MessageBody: ComponentType<MessageBodyProps> }>();
  const Real = original.MessageBody;
  const Counted = memo(function Counted(props: MessageBodyProps) {
    renders.body++;
    return <Real {...props} />;
  });
  return { ...original, MessageBody: Counted };
});

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

describe('<MessageItem /> re-renders', () => {
  it('leaves the body alone when only focus changes', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
    });
    await act(async () => {
      await snowdrop.send.send({
        conversationId: conv.id,
        text: 'hello there',
        mentionIds: [],
        attachments: [],
      });
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
    const row = screen.getByRole('article');
    const before = renders.body;
    expect(before).toBeGreaterThan(0);
    act(() => {
      fireEvent.focus(row);
    });
    act(() => {
      fireEvent.blur(row);
    });
    act(() => {
      fireEvent.focus(row);
    });
    expect(renders.body).toBe(before);
  });
});
