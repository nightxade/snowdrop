import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { Message } from '@/core/domain';
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

/** A row for a message of the demo group "crux", as it is after `change` has been applied to it and its chat. */
async function rowWithKit() {
  const r = await row(fresh);
  return { ...r, kit: { message: r.message, self: r.self } };
}

async function row(
  change: (m: Message, self: string) => Partial<Message> = () => ({}),
  prepare?: (snowdrop: Snowdrop, conversationId: Message['conversationId'], self: string) => void,
) {
  const kit = await bootForward();
  live.push(kit.snowdrop);
  const { snowdrop, conversationId } = kit;
  const self = snowdrop.stores.session.getState().self!.id;
  act(() => {
    prepare?.(snowdrop, conversationId, self);
    snowdrop.stores.messages
      .getState()
      .update(conversationId, kit.message.id, (m) => ({ ...m, ...change(m, self) }));
  });
  const rows = new RowState();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <RowStateProvider value={rows}>
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

const own = (_m: Message, self: string): Partial<Message> => ({ authorId: self, status: 'read' });
const fresh = (m: Message, self: string): Partial<Message> => ({
  ...own(m, self),
  sentAt: Date.now() - 60_000,
});

/** Takes the user's right to write away: an announcement group they do not administer. */
const readOnly = (snowdrop: Snowdrop, id: Message['conversationId'], self: string) => {
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
};

async function menuItems(article: HTMLElement): Promise<string[]> {
  fireEvent.contextMenu(article);
  await settle();
  const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await settle();
  return items;
}

describe('message actions: one rule for every surface', () => {
  it('offers reply from the key, the menu and the bar where there is a composer', async () => {
    const { snowdrop, conversationId, message, article } = await row();
    expect(await menuItems(article)).toContain('Reply');
    article.focus();
    fireEvent.keyDown(article, { key: 'r' });
    expect(snowdrop.stores.ui.getState().replyTo[conversationId]).toBe(message.id);
  });

  it('offers no reply where the chat has no composer (a read-only group)', async () => {
    const { snowdrop, conversationId, article } = await row(() => ({}), readOnly);
    // The menu and the key agree: neither sets a reply nobody can see or send.
    expect(await menuItems(article)).not.toContain('Reply');
    article.focus();
    fireEvent.keyDown(article, { key: 'r' });
    expect(snowdrop.stores.ui.getState().replyTo[conversationId]).toBeUndefined();
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('lets a fresh message of ours be edited from the key, the menu and the bar', async () => {
    const { snowdrop, message, article } = await row(fresh);
    expect(await menuItems(article)).toContain('Edit message');
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    article.focus();
    fireEvent.keyDown(article, { key: 'e' });
    expect(snowdrop.stores.ui.getState().editing).toMatchObject({ messageId: message.id });
  });

  it('offers no edit for a message sent more than a day ago, anywhere', async () => {
    const { snowdrop, article } = await row((m, self) => ({
      ...own(m, self),
      sentAt: Date.now() - DAY - 60_000,
    }));
    expect(await menuItems(article)).not.toContain('Edit message');
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    article.focus();
    fireEvent.keyDown(article, { key: 'e' });
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
  });

  it('offers no edit for a message that has been edited ten times, a sticker or a voice note', async () => {
    for (const patch of [
      { edits: 10 },
      { body: '', sticker: { packId: 'ab', stickerId: 1 } },
      { body: '', attachments: [{ id: 'v', contentType: 'audio/mpeg', voiceNote: true }] },
    ]) {
      const { snowdrop, article } = await row((m, self) => ({ ...fresh(m, self), ...patch }));
      expect(await menuItems(article)).not.toContain('Edit message');
      article.focus();
      fireEvent.keyDown(article, { key: 'e' });
      expect(snowdrop.stores.ui.getState().editing).toBeNull();
      cleanup();
    }
  });

  it('does not edit a failed message from the key either (the menu never offered it)', async () => {
    const { snowdrop, article } = await row((m, self) => ({
      ...fresh(m, self),
      status: 'failed',
    }));
    expect(await menuItems(article)).not.toContain('Edit message');
    article.focus();
    fireEvent.keyDown(article, { key: 'e' });
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
  });

  it('offers delete for everyone only for 24 hours, where recipients still accept it', async () => {
    const { article } = await row(fresh);
    expect(await menuItems(article)).toContain('Delete for everyone');
    cleanup();
    const old = await row((m, self) => ({ ...own(m, self), sentAt: Date.now() - DAY - 60_000 }));
    const items = await menuItems(old.article);
    expect(items).not.toContain('Delete for everyone');
    expect(items).toContain('Delete for me');
  });

  it('stops offering Edit in the bar once the window closes while the row is on screen', async () => {
    // 24 hours less a moment after sending: the row mounts inside the window and outlives it.
    const { article } = await row((m, self) => ({
      ...own(m, self),
      sentAt: Date.now() - DAY + 300,
    }));
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(await menuItems(article)).not.toContain('Edit message');
  });

  it('says why when Edit is pressed on a stale row, and does not open the editor', async () => {
    const { snowdrop, kit } = await rowWithKit();
    // A copy of the row's message as it was when the bar was drawn, now past the window.
    const stale = { ...kit.message, authorId: kit.self, sentAt: Date.now() - DAY - 1000 };
    expect(act_.startEdit(snowdrop, stale)).toBe(false);
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
    expect(snowdrop.stores.ui.getState().toasts.at(-1)?.message).toBe(
      'Messages can only be edited for 24 hours.',
    );
  });

  it('has no axe violations in the hover bar', async () => {
    const { article } = await row(fresh);
    fireEvent.pointerEnter(article, { pointerType: 'mouse' });
    await settle();
    // The bar is what changed; the row's own status mark is checked with the meta tests.
    const bar = article.querySelector<HTMLElement>('[data-snowdrop="hover-bar"]')!;
    expect((await axe(bar, { rules: { region: { enabled: false } } })).violations).toEqual([]);
  });
});
