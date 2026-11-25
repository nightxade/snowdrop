import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { applyDelete, type Message } from '@/core/domain';
import { bootForward } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { RowState, RowStateProvider } from '../list/rowState';
import * as act_ from './actions';
import { MessageItem } from './MessageItem';

const live: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

const DAY = 24 * 3_600_000;

async function row(change: (self: string) => Partial<Message> = () => ({})) {
  const kit = await bootForward();
  live.push(kit.snowdrop);
  const { snowdrop, conversationId } = kit;
  const self = snowdrop.stores.session.getState().self!.id;
  act(() => {
    snowdrop.stores.messages
      .getState()
      .update(conversationId, kit.message.id, (m) => ({ ...m, ...change(self) }));
  });
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <RowStateProvider value={new RowState()}>
        <div data-snowdrop="message-log">
          <MessageItem
            conversationId={conversationId}
            id={kit.message.id}
            continuation={false}
            compact={false}
            compactAvatars={false}
          />
        </div>
      </RowStateProvider>
    </ChatControllerProvider>,
  );
  await settle(snowdrop);
  return { ...kit, self, article: screen.getByRole('article') };
}

/** Keys a focused row, and whether the row took the key (nothing is left to type into the composer). */
function press(article: HTMLElement, key: string): boolean {
  article.focus();
  return !fireEvent.keyDown(article, { key });
}

const own = (self: string): Partial<Message> => ({ authorId: self, status: 'read' });
const oldOwn = (self: string): Partial<Message> => ({
  ...own(self),
  sentAt: Date.now() - DAY - 60_000,
});

/** The user may no longer write in the chat (an announcement group they do not administer). */
function readOnly(snowdrop: Snowdrop, id: Message['conversationId'], self: string) {
  act(() => {
    const conv = snowdrop.stores.conversations.getState().byId[id]!;
    snowdrop.stores.conversations.getState().upsert({
      ...conv,
      adminIds: conv.adminIds.filter((a) => a !== self),
      permissions: {
        addMember: 'every-member',
        editDetails: 'every-member',
        ...conv.permissions,
        sendMessages: 'only-admins',
      },
    });
  });
}

describe("a row key that is refused is still the row's", () => {
  it('says why E does nothing on your own message past the window, and types nothing', async () => {
    const { snowdrop, article } = await row(oldOwn);
    expect(press(article, 'e')).toBe(true);
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
    expect(snowdrop.stores.ui.getState().toasts.at(-1)?.message).toBe(
      'Messages can only be edited for 24 hours.',
    );
  });

  it('keeps R, Delete and + from falling through to the composer when they are refused', async () => {
    const { snowdrop, conversationId, self, article } = await row();
    readOnly(snowdrop, conversationId, self);
    await settle(snowdrop);
    expect(press(article, 'r')).toBe(true);
    expect(press(article, '+')).toBe(true);
    expect(snowdrop.stores.ui.getState().replyTo[conversationId]).toBeUndefined();
    // E on someone else's message, and Delete on a failed one, are the row's too.
    expect(press(article, 'e')).toBe(true);
    cleanup();
    const failed = await row((s) => ({ ...own(s), status: 'failed' }));
    expect(press(failed.article, 'Delete')).toBe(true);
  });
});

describe('sending actions follow whether the chat can send', () => {
  async function menu(article: HTMLElement): Promise<string[]> {
    fireEvent.contextMenu(article);
    await settle();
    return (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
  }

  it('offers no reaction, edit, pin or delete for everyone where you cannot send, but copy and delete for me', async () => {
    const { snowdrop, conversationId, self, article } = await row((s) => ({
      ...own(s),
      sentAt: Date.now() - 60_000,
    }));
    expect(await menu(article)).toEqual(
      expect.arrayContaining(['Edit message', 'Pin message', 'Delete for everyone']),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    readOnly(snowdrop, conversationId, self);
    await settle(snowdrop);
    const items = await menu(article);
    expect(items).toEqual(expect.arrayContaining(['Copy text', 'Delete for me']));
    for (const gone of ['Edit message', 'Pin message', 'Delete for everyone'])
      expect(items).not.toContain(gone);
    expect(items.some((i) => i.includes('Add reaction'))).toBe(false);
    // The key says why, and opens no editor.
    expect(press(article, 'e')).toBe(true);
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
    expect(snowdrop.stores.ui.getState().toasts.at(-1)?.message).toMatch(/can't edit/u);
  });
});

describe('an open menu follows the data it was built from', () => {
  it('gains Pin message when the chat turns out to be accepted while the menu is open', async () => {
    const { snowdrop, conversationId, article } = await row();
    // Before contacts and accepted chats are known the chat looks like a request.
    act(() => {
      snowdrop.stores.contacts.setState((s) => ({
        byId: Object.fromEntries(
          Object.entries(s.byId).map(([id, c]) => [
            id,
            { ...c, inContacts: false, profileSharing: false },
          ]),
        ),
      }));
      snowdrop.stores.local.setState({ acceptedChats: {} });
    });
    await settle(snowdrop);
    fireEvent.contextMenu(article);
    await settle();
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).not.toContain(
      'Pin message',
    );
    act(() => {
      snowdrop.stores.local.getState().markAccepted(conversationId, 1);
    });
    await settle(snowdrop);
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toContain(
      'Pin message',
    );
  });
});

describe('picking the emoji you reacted with', () => {
  it('removes your reaction, from the picker and the quick reactions alike', async () => {
    const { snowdrop, conversationId, message } = await row();
    const self = snowdrop.stores.session.getState().self!.id;
    // A message the demo backend knows (the seeded one exists only on screen).
    const window = snowdrop.stores.messages.getState().windows[conversationId]!;
    const known = window.ids.find((id) => id !== message.id && window.byId[id]?.kind === 'normal')!;
    const current = () => snowdrop.stores.messages.getState().windows[conversationId]!.byId[known]!;
    act_.react(snowdrop, current(), '👍');
    await settle(snowdrop);
    expect(current().reactions.some((r) => r.authorId === self && r.emoji === '👍')).toBe(true);
    act_.react(snowdrop, current(), '👍');
    await settle(snowdrop);
    expect(current().reactions.some((r) => r.authorId === self)).toBe(false);
  });
});

describe('a quote of a message deleted for everyone', () => {
  it('stops showing its text and says it was deleted, keeping the author', async () => {
    const { snowdrop, conversationId, message } = await row();
    const window = snowdrop.stores.messages.getState().windows[conversationId]!;
    const quoted =
      window.byId[
        window.ids.find((id) => id !== message.id && window.byId[id]?.kind === 'normal')!
      ]!;
    act(() => {
      snowdrop.stores.messages.getState().update(conversationId, message.id, (m) => ({
        ...m,
        quote: { authorId: quoted.authorId, sentAt: quoted.sentAt, text: 'the words it had' },
      }));
    });
    await settle(snowdrop);
    const quote = () => document.querySelector('[data-snowdrop="message-quote"]')!;
    expect(quote().textContent).toContain('the words it had');
    act(() => {
      snowdrop.stores.messages.getState().update(conversationId, quoted.id, (m) => applyDelete(m));
    });
    await settle(snowdrop);
    expect(quote().textContent).not.toContain('the words it had');
    expect(quote().textContent).toContain('This message was deleted.');
    expect(quote().textContent).toContain(
      snowdrop.stores.contacts.getState().byId[quoted.authorId]!.name,
    );
  });
});

describe('the hover bar while focus is inside it', () => {
  it('stays when the pointer leaves, and hands focus to the row when it goes', async () => {
    const { snowdrop, conversationId, message, article } = await row();
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    const bar = () => document.querySelector('[data-snowdrop="hover-bar"]');
    const button = screen.getAllByRole('button', { name: /^React with/u })[0]!;
    act(() => {
      button.focus();
    });
    fireEvent.pointerLeave(article, { pointerType: 'mouse' });
    await settle();
    expect(bar()).not.toBeNull();
    expect(document.activeElement).toBe(button);
    act(() => {
      snowdrop.stores.messages
        .getState()
        .update(conversationId, message.id, (m): Message => ({ ...m, kind: 'system' }));
    });
    await settle();
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(article);
  });
});
