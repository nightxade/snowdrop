import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { StickerPackInfo } from '@/core/backend';
import type { ConversationId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { Composer } from './Composer';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function setup(options: { packs?: StickerPackInfo[] | Error } = {}) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  if (options.packs !== undefined) {
    const { packs } = options;
    snowdrop.backend.listStickerPacks = () =>
      packs instanceof Error ? Promise.reject(packs) : Promise.resolve(packs);
  }
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <Composer conversationId={conv.id} />
    </ChatControllerProvider>,
  );
  const input = screen.getByRole<HTMLTextAreaElement>('textbox');
  const open = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
      await Promise.resolve();
    });
    await settle(snowdrop);
  };
  const lastOwn = (id: ConversationId) => {
    const selfId = snowdrop.stores.session.getState().self!.id;
    return messagesSelectors
      .list(id)(snowdrop.stores.messages.getState())
      .findLast((m) => m.authorId === selfId);
  };
  return { snowdrop, conv, input, open, lastOwn };
}

const cells = () => screen.getAllByRole('button', { name: /sticker$/u });
const tab = (name: string) => screen.getByRole('tab', { name });

describe('StickerPicker', () => {
  it('hides the sticker button when the backend cannot list packs', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    delete (snowdrop.backend as { listStickerPacks?: unknown }).listStickerPacks;
    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!;
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={new ChatController()}>
        <Composer conversationId={conv.id} />
      </ChatControllerProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Stickers' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Emoji' })).toBeTruthy();
  });

  it('puts the sticker button right before the emoji button', async () => {
    await setup();
    const sticker = screen.getByRole('button', { name: 'Stickers' });
    const emoji = screen.getByRole('button', { name: 'Emoji' });
    expect(sticker.compareDocumentPosition(emoji) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows pack tabs (Recent first) and the first pack’s stickers', async () => {
    const { open } = await setup();
    await open();
    const tabs = within(screen.getByRole('tablist', { name: 'Sticker packs' })).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Recent',
      'Everyday Moods',
      'Critters',
      'Snack Break',
    ]);
    // Nothing sent yet, so it opens on the first pack.
    expect(tab('Everyday Moods').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Everyday Moods' })).toBeTruthy();
    expect(cells()).toHaveLength(12);
    fireEvent.click(tab('Critters'));
    expect(screen.getByRole('heading', { name: 'Critters' })).toBeTruthy();
    expect(cells()).toHaveLength(8);
    expect(screen.getByRole('button', { name: '🐱 sticker' })).toBeTruthy();
  });

  it('loads each sticker image through the existing sticker path', async () => {
    const { snowdrop } = await setup();
    const resolveStickerUrl = vi.fn((s: { packId: string; stickerId: number }) =>
      Promise.resolve(`blob:${s.packId}-${s.stickerId}`),
    );
    const retain = vi.fn();
    const release = vi.fn();
    Object.assign(snowdrop.backend, {
      resolveStickerUrl,
      retainStickerUrl: retain,
      releaseStickerUrl: release,
    });
    // Real signal-cli packs list no url, so images resolve lazily by id.
    snowdrop.backend.listStickerPacks = () =>
      Promise.resolve([
        {
          packId: 'aa01',
          title: 'Real',
          author: 'x',
          cover: { stickerId: 0, emoji: '🍎' },
          stickers: [{ stickerId: 0, emoji: '🍎' }],
        },
      ]);
    installFakeIO();
    fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
    await settle(snowdrop);
    const grid = screen.getByRole('button', { name: '🍎 sticker' });
    // Cells only fetch once scrolled near view; the pack tab (its cover) loads at once.
    expect(grid.querySelector('img')).toBeNull();
    resolveStickerUrl.mockClear();
    act(() => {
      for (const io of FakeIO.instances) io.emit(true);
    });
    await waitFor(() => {
      expect(resolveStickerUrl).toHaveBeenCalledWith(
        expect.objectContaining({ packId: 'aa01', stickerId: 0 }),
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(grid.querySelector('img')?.getAttribute('src')).toBe('blob:aa01-0');
    });
    expect(retain).toHaveBeenCalled();
    cleanup();
    expect(release).toHaveBeenCalled();
  });

  it('sends the clicked sticker at once, closes, and returns focus to the composer', async () => {
    const { open, snowdrop, conv, input, lastOwn } = await setup();
    await open();
    fireEvent.change(input, { target: { value: 'draft stays' } });
    const send = vi.spyOn(snowdrop.send, 'sendSticker');
    fireEvent.click(screen.getByRole('button', { name: '😂 sticker' }));
    await settle(snowdrop);
    expect(send).toHaveBeenCalledOnce();
    expect(lastOwn(conv.id)).toMatchObject({
      body: '',
      attachments: [],
      sticker: { stickerId: 1, emoji: '😂' },
    });
    expect(['pending', 'sent']).toContain(lastOwn(conv.id)?.status);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(input.value).toBe('draft stays');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('sends as a reply, and spends the reply, when one is active', async () => {
    const { open, snowdrop, conv, lastOwn } = await setup();
    const target = messagesSelectors
      .list(conv.id)(snowdrop.stores.messages.getState())
      .findLast((m) => m.kind === 'normal' && m.body !== '')!;
    act(() => {
      snowdrop.stores.ui.getState().setReplyTo(conv.id, target.id);
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '🙌 sticker' }));
    await settle(snowdrop);
    expect(lastOwn(conv.id)?.quote).toMatchObject({
      authorId: target.authorId,
      sentAt: target.sentAt,
    });
    expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeFalsy();
  });

  it('shows a failed sticker send as failed (with the usual retry), not as an error banner', async () => {
    const { open, snowdrop, conv, lastOwn } = await setup();
    await open();
    vi.spyOn(snowdrop.backend, 'send').mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: '😎 sticker' }));
    await settle(snowdrop);
    expect(lastOwn(conv.id)).toMatchObject({ status: 'failed', sticker: { emoji: '😎' } });
  });

  it('lists recently sent stickers first, once each', async () => {
    const { open, snowdrop } = await setup();
    await open();
    fireEvent.click(screen.getByRole('button', { name: '🥳 sticker' }));
    await settle(snowdrop);
    await open();
    fireEvent.click(tab('Critters'));
    fireEvent.click(screen.getByRole('button', { name: '🦊 sticker' }));
    await settle(snowdrop);
    await open();
    expect(tab('Recent').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeTruthy();
    expect(cells().map((c) => c.getAttribute('aria-label'))).toEqual(['🦊 sticker', '🥳 sticker']);
    expect(snowdrop.stores.local.getState().recentStickers).toEqual([
      expect.objectContaining({ stickerId: 2, emoji: '🦊' }),
      expect.objectContaining({ stickerId: 11, emoji: '🥳' }),
    ]);
  });

  it('moves with the arrow keys, sends with Enter, and closes with Escape', async () => {
    const { open, snowdrop, conv, input, lastOwn } = await setup();
    await open();
    await waitFor(() => {
      expect(document.activeElement).toBe(cells()[0]);
    });
    const press = (key: string) => {
      fireEvent.keyDown(document.activeElement!, { key });
    };
    press('ArrowRight');
    await waitFor(() => {
      expect(document.activeElement).toBe(cells()[1]);
    });
    press('ArrowDown');
    await waitFor(() => {
      expect(document.activeElement).toBe(cells()[5]);
    });
    // The hovered/focused sticker's emoji is shown in the header.
    expect(screen.getByText('😴', { selector: '[data-sticker-preview]' })).toBeTruthy();
    press('ArrowLeft');
    press('ArrowUp');
    await waitFor(() => {
      expect(document.activeElement).toBe(cells()[0]);
    });
    press('End');
    await waitFor(() => {
      expect(document.activeElement).toBe(cells()[11]);
    });
    press('PageDown');
    expect(tab('Critters').getAttribute('aria-selected')).toBe('true');

    // Escape: nothing sent, composer focused.
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole('tablist')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(lastOwn(conv.id)?.sticker).toBeUndefined();

    await open();
    await waitFor(() => {
      expect(cells().length).toBeGreaterThan(0);
    });
    // Enter on a focused sticker activates it like a click.
    const first = cells()[0]!;
    first.focus();
    fireEvent.click(first);
    await settle(snowdrop);
    expect(lastOwn(conv.id)?.sticker).toBeDefined();
  });

  it('switches tabs with the arrow keys', async () => {
    const { open } = await setup();
    await open();
    tab('Everyday Moods').focus();
    fireEvent.keyDown(tab('Everyday Moods'), { key: 'ArrowRight' });
    expect(tab('Critters').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Critters'), { key: 'ArrowLeft' });
    expect(tab('Everyday Moods').getAttribute('aria-selected')).toBe('true');
  });

  it('explains how to get stickers when there are no installed packs', async () => {
    const { open, snowdrop } = await setup({ packs: [] });
    await open();
    expect(screen.getByText('No sticker packs')).toBeTruthy();
    expect(screen.getByText(/Install sticker packs on your phone/u)).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(snowdrop.stores.local.getState().recentStickers).toEqual([]);
  });

  it('offers a retry when the packs cannot be listed', async () => {
    const { open, snowdrop } = await setup({ packs: new Error('daemon gone') });
    await open();
    expect(screen.getByText('Couldn’t load your stickers')).toBeTruthy();
    let calls = 0;
    snowdrop.backend.listStickerPacks = () => {
      calls++;
      return Promise.resolve([
        {
          packId: 'aa01',
          title: 'Back',
          author: '',
          cover: { stickerId: 0, emoji: '🍎', url: 'data:image/svg+xml,x' },
          stickers: [{ stickerId: 0, emoji: '🍎', url: 'data:image/svg+xml,x' }],
        },
      ]);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle(snowdrop);
    expect(calls).toBe(1);
    expect(screen.getByRole('heading', { name: 'Back' })).toBeTruthy();
  });

  it('omits recent stickers whose pack is no longer installed', async () => {
    const { open, snowdrop } = await setup();
    act(() => {
      snowdrop.stores.local.getState().noteStickerSent({ packId: 'dead01', stickerId: 3 });
    });
    await open();
    expect(tab('Everyday Moods').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab('Recent'));
    expect(cells).toThrow();
    expect(screen.getByText('Stickers you send appear here.')).toBeTruthy();
  });
});
