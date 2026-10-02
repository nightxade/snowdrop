import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Shrike } from '@/app/createShrike';
import { MockBackend } from '@/core/backend/mock';
import type { ConversationId, Message, MessageId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootShrike, renderWithShrike, settle } from '@/test/renderWithShrike';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { quoteOf } from '../composer/useComposer';
import { MessageItem } from './MessageItem';

const shrikes: Shrike[] = [];
afterEach(async () => {
  cleanup();
  for (const s of shrikes.splice(0)) await s.dispose();
});

async function withOwnMessage(options: { fail?: boolean } = {}) {
  const shrike = await bootShrike();
  shrikes.push(shrike);
  const conv = Object.values(shrike.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    shrike.stores.ui.getState().selectConversation(conv.id);
    await shrike.history.open(conv.id);
  });
  // shrike.backend is a lazy-loading proxy; the concrete adapter is backendReady.
  const backend = await shrike.backendReady;
  if (options.fail && backend instanceof MockBackend) backend.failNext();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => {
    await shrike.send.send({
      conversationId: conv.id,
      text: 'from the keyboard',
      mentionIds: [],
      attachments: [],
    });
  });
  const selfId = shrike.stores.session.getState().self!.id;
  const own = messagesSelectors
    .list(conv.id)(shrike.stores.messages.getState())
    .findLast((m) => m.authorId === selfId)!;
  const chat = new ChatController();
  renderWithShrike(
    shrike,
    <ChatControllerProvider value={chat}>
      <div data-shrike="message-log">
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
  return { shrike, conv: conv.id, own, row, chat };
}

const current = (shrike: Shrike, conv: ConversationId, id: MessageId) =>
  messagesSelectors.message(conv, id)(shrike.stores.messages.getState());

describe('<MessageItem /> keyboard', () => {
  it('is an article labelled by author and time, described by its body', async () => {
    const { row } = await withOwnMessage();
    const label = document.getElementById(row.getAttribute('aria-labelledby')!);
    expect(label?.textContent).toMatch(/^Juniper Hale, \d{2}:\d{2}$/u);
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toBe(
      'from the keyboard',
    );
    expect(row.getAttribute('aria-keyshortcuts')).toContain('R');
  });

  it('keeps inner controls out of the tab order until the row is entered', async () => {
    const { row } = await withOwnMessage();
    const inner = within(row).getAllByRole('button');
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('R replies, E edits', async () => {
    const { shrike, conv, own, row } = await withOwnMessage();
    row.focus();
    fireEvent.keyDown(row, { key: 'r' });
    expect(shrike.stores.ui.getState().replyTo[conv]).toBe(own.id);
    fireEvent.keyDown(row, { key: 'e' });
    expect(shrike.stores.ui.getState().editing).toMatchObject({ messageId: own.id });
  });

  it('+ opens the reaction picker', async () => {
    const { row } = await withOwnMessage();
    row.focus();
    fireEvent.keyDown(row, { key: '+' });
    await settle();
    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeTruthy();
  });

  it('Delete asks first, with the destructive button focused so Enter confirms', async () => {
    const { shrike, conv, own, row } = await withOwnMessage();
    row.focus();
    fireEvent.keyDown(row, { key: 'Delete' });
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Delete for everyone' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete for everyone' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    await settle(shrike);
    expect(current(shrike, conv, own.id)?.deleted).toBe(true);
    expect(screen.getByText('You deleted this message.')).toBeTruthy();
  });
});

describe('<MessageItem /> failed send', () => {
  it('offers Retry and Delete', async () => {
    const { shrike, conv, own, row } = await withOwnMessage({ fail: true });
    expect(own.status).toBe('failed');
    expect(within(row).getByText('Failed to send')).toBeTruthy();
    const retry = vi.spyOn(shrike.send, 'retry').mockResolvedValue();
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith(conv, own.nonce);
    const discard = vi.spyOn(shrike.send, 'discard').mockResolvedValue();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(discard).toHaveBeenCalledWith(conv, own.nonce);
  });
});

describe('quoteOf', () => {
  it('copies the quoted message’s attachment types (Signal shows them natively)', () => {
    const m = {
      authorId: 'a',
      sentAt: 5,
      body: '',
      ranges: [],
      attachments: [
        {
          id: '1',
          contentType: 'image/png',
          fileName: 'p.png',
          url: 'blob:x',
          width: 1,
          height: 1,
        },
        { id: '2', contentType: 'application/pdf' },
      ],
    } as unknown as Message;
    expect(quoteOf(m)).toEqual({
      authorId: 'a',
      sentAt: 5,
      text: '',
      attachments: [
        { contentType: 'image/png', fileName: 'p.png' },
        { contentType: 'application/pdf' },
      ],
    });
  });
});
