import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { MessageCommand } from '@/core/commands';
import type { Message } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { bootForward } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { RowState, RowStateProvider } from '../list/rowState';
import { buildMessageMenu } from './messageMenu';
import { MessageItem } from './MessageItem';

const live: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

async function row(patch: Partial<Message> = {}) {
  const kit = await bootForward(patch);
  live.push(kit.snowdrop);
  const rows = new RowState();
  renderWithSnowdrop(
    kit.snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <RowStateProvider value={rows}>
        <div data-snowdrop="message-log">
          <MessageItem
            conversationId={kit.conversationId}
            id={kit.message.id}
            continuation={false}
            compact={false}
            compactAvatars={false}
          />
        </div>
      </RowStateProvider>
    </ChatControllerProvider>,
  );
  await settle(kit.snowdrop);
  return { ...kit, rows, article: screen.getByRole('article') };
}

const modal = (s: Snowdrop) => uiSelectors.modal(s.stores.ui.getState());

/** Whether the message's menu offers Forward, for a message (and a conversation) as the stores hold them. */
async function offered(patch: Partial<Message>, prepare?: (s: Snowdrop) => void) {
  const kit = await bootForward(patch);
  live.push(kit.snowdrop);
  prepare?.(kit.snowdrop);
  const m =
    kit.snowdrop.stores.messages.getState().windows[kit.conversationId]!.byId[kit.message.id]!;
  const entries = buildMessageMenu(kit.snowdrop, new ChatController(), m, {
    openPicker: () => undefined,
    requestDelete: () => undefined,
    openDetails: () => undefined,
    requestEndPoll: () => undefined,
    openStickerPack: () => undefined,
    openCustomEmoji: () => undefined,
  });
  return entries.some((e) => e.kind === 'item' && e.id === 'forward');
}

describe('Forward in a message’s menu', () => {
  it('is in the context menu and opens the dialog for that message', async () => {
    const { snowdrop, article, conversationId, message } = await row();
    fireEvent.contextMenu(article);
    await settle();
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    // After Reply, as in Signal Desktop's menu.
    expect(items.indexOf('Forward')).toBe(items.indexOf('Reply') + 1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Forward' }));
    await settle(snowdrop);
    expect(modal(snowdrop)).toEqual({
      type: 'forward',
      props: { conversationId, messageIds: [message.id] },
    });
  });

  it('is offered for text, files and stickers', async () => {
    expect(await offered({})).toBe(true);
    expect(await offered({ body: '', attachments: [{ id: 'a', contentType: 'image/png' }] })).toBe(
      true,
    );
    expect(await offered({ body: '', sticker: { packId: 'ab', stickerId: 1 } })).toBe(true);
  });

  it('is not offered for a poll, a deleted message, a system line, or an empty one', async () => {
    expect(
      await offered({
        body: '',
        poll: { question: 'q?', options: ['a', 'b'], allowMultiple: false, votes: [] },
      }),
    ).toBe(false);
    expect(await offered({ deleted: true })).toBe(false);
    expect(await offered({ kind: 'system', systemText: 'x' })).toBe(false);
    expect(await offered({ body: '   ' })).toBe(false);
  });

  it('is not offered before the chat is accepted: forwarding needs the files, and media is held back', async () => {
    const kit = await bootForward();
    live.push(kit.snowdrop);
    const id = kit.chat('request-dm');
    await act(async () => {
      await kit.snowdrop.history.open(id);
    });
    const m = {
      ...kit.message,
      id: `${kit.authorId}:42` as Message['id'],
      conversationId: id,
    } satisfies Message;
    const entries = buildMessageMenu(kit.snowdrop, new ChatController(), m, {
      openPicker: () => undefined,
      requestDelete: () => undefined,
      openDetails: () => undefined,
      requestEndPoll: () => undefined,
      openStickerPack: () => undefined,
      openCustomEmoji: () => undefined,
    });
    expect(entries.some((e) => e.kind === 'item' && e.id === 'forward')).toBe(false);
  });
});

describe('Forward from the keyboard', () => {
  it('Ctrl+Shift+S on the focused message (Signal Desktop’s shortcut) opens the dialog', async () => {
    const { snowdrop, article, message } = await row();
    article.focus();
    fireEvent.keyDown(article, { key: 'S', ctrlKey: true, shiftKey: true });
    expect(modal(snowdrop)).toMatchObject({
      type: 'forward',
      props: { messageIds: [message.id] },
    });
  });

  it('works with Cmd on a Mac, and ignores plain S and Ctrl+S', async () => {
    const { snowdrop, article } = await row();
    article.focus();
    fireEvent.keyDown(article, { key: 's' });
    fireEvent.keyDown(article, { key: 's', ctrlKey: true });
    expect(modal(snowdrop)).toBeNull();
    fireEvent.keyDown(article, { key: 's', metaKey: true, shiftKey: true });
    expect(modal(snowdrop)?.type).toBe('forward');
  });

  it('does nothing on a message that cannot be forwarded', async () => {
    const { snowdrop, article } = await row({ deleted: true });
    article.focus();
    fireEvent.keyDown(article, { key: 'S', ctrlKey: true, shiftKey: true });
    expect(modal(snowdrop)).toBeNull();
  });

  it('is announced on the message', async () => {
    const { article } = await row();
    expect(article.getAttribute('aria-keyshortcuts')).toContain('Control+Shift+S');
  });

  it('is a command for key layers: the focused row forwards, with no default key', async () => {
    const { snowdrop, rows, message } = await row();
    expect(MessageCommand.Forward).toBe('chat.message.forward');
    expect(rows.runAction(message.id, 'forward')).toBe(true);
    expect(modal(snowdrop)?.type).toBe('forward');
  });
});
