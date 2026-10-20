import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { Message } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const WINTER = '3c0ffee5ab1e4d2790a8d1f06b7c4e19';

/** jsdom never decodes images; this one "loads" at 48 × 48. */
function stubImage() {
  class FakeImage {
    naturalWidth = 48;
    naturalHeight = 48;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

/** A received message from the demo world's Design Crit group, rendered as a row. */
async function row(pick: (m: Message) => boolean) {
  stubImage();
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Design Crit',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const message = messagesSelectors.list(conv.id)(snowdrop.stores.messages.getState()).find(pick)!;
  expect(message).toBeDefined();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={conv.id}
          id={message.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
    </ChatControllerProvider>,
  );
  await settle(snowdrop);
  return { snowdrop, message, article: screen.getByRole('article') };
}

const packSticker = (m: Message) => m.sticker?.packId === WINTER;
const withEmoji = (m: Message) => (m.customEmoji?.length ?? 0) > 0;

describe('a received sticker', () => {
  it('opens its pack from a click on the sticker, and returns focus to it', async () => {
    const { snowdrop } = await row(packSticker);
    const button = screen.getByRole('button', { name: '🧣 sticker, view sticker pack' });
    expect(button.hasAttribute('data-open-attachment')).toBe(true);
    button.focus();
    fireEvent.click(button);
    await settle(snowdrop);
    const dialog = screen.getByRole('dialog', { name: 'Winter Folk' });
    expect(within(dialog).getByRole('button', { name: 'Install' })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('has "View sticker pack" in its context menu', async () => {
    const { snowdrop, article } = await row(packSticker);
    fireEvent.contextMenu(article);
    await settle();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View sticker pack' }));
    await settle(snowdrop);
    expect(screen.getByRole('dialog', { name: 'Winter Folk' })).toBeTruthy();
  });

  it('installs from the dialog, so the pack is then listed for the picker', async () => {
    const { snowdrop } = await row(packSticker);
    fireEvent.click(screen.getByRole('button', { name: '🧣 sticker, view sticker pack' }));
    await settle(snowdrop);
    expect((await snowdrop.backend.listStickerPacks?.())?.map((p) => p.title)).not.toContain(
      'Winter Folk',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await settle(snowdrop);
    expect(screen.getByRole('button', { name: 'Installed' })).toBeTruthy();
    expect((await snowdrop.backend.listStickerPacks?.())?.map((p) => p.title)).toContain(
      'Winter Folk',
    );
  });

  it('is a plain image, with no menu item, when the backend cannot show packs', async () => {
    stubImage();
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    delete (snowdrop.backend as { getStickerPack?: unknown }).getStickerPack;
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Design Crit',
    )!;
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
    });
    const message = messagesSelectors
      .list(conv.id)(snowdrop.stores.messages.getState())
      .find(packSticker)!;
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={new ChatController()}>
        <div data-snowdrop="message-log">
          <MessageItem
            conversationId={conv.id}
            id={message.id}
            continuation={false}
            compact={false}
            compactAvatars={false}
          />
        </div>
      </ChatControllerProvider>,
    );
    await settle(snowdrop);
    expect(screen.queryByRole('button', { name: /view sticker pack/u })).toBeNull();
    fireEvent.contextMenu(screen.getByRole('article'));
    await settle();
    expect(screen.queryByRole('menuitem', { name: 'View sticker pack' })).toBeNull();
  });
});

describe('a received custom emoji', () => {
  it('opens a popover from the inline emoji that adds it to your collection', async () => {
    const { snowdrop } = await row(withEmoji);
    const trigger = screen.getByRole('button', {
      name: 'Custom emoji :partyblob:, add to my emoji',
    });
    fireEvent.click(trigger);
    await settle(snowdrop);
    const add = await screen.findByRole('button', { name: 'Add to my emoji' });
    fireEvent.click(add);
    expect(snowdrop.stores.local.getState().customEmoji.map((e) => e.name)).toEqual(['partyblob']);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Added.');
    });
  });

  it('has an "Add :name: to my emoji" context menu item that opens the same card in a dialog', async () => {
    const { snowdrop, article } = await row(withEmoji);
    fireEvent.contextMenu(article);
    await settle();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add :partyblob: to my emoji' }));
    await settle(snowdrop);
    const dialog = screen.getByRole('dialog', { name: 'Add to my emoji' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add to my emoji' }));
    expect(snowdrop.stores.local.getState().customEmoji.map((e) => e.name)).toEqual(['partyblob']);
  });
});
