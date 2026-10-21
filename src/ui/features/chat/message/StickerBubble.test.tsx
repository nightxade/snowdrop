import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, ConversationId, StickerContent } from '@/core/domain';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { StickerBubble } from './StickerBubble';

afterEach(cleanup);

const conversationId = 'conv-1' as ConversationId;

function fakeApp(backend: Partial<AppServices['backend']>): AppServices {
  return {
    backend: { kind: 'signal-cli', ...backend },
    stores: createStores(),
  } as unknown as AppServices;
}

function renderSticker(
  sticker: StickerContent,
  backend: Partial<AppServices['backend']>,
  onOpen?: () => void,
) {
  return render(
    <SnowdropContextProvider value={fakeApp(backend)}>
      <StickerBubble conversationId={conversationId} sticker={sticker} onOpen={onOpen} />
    </SnowdropContextProvider>,
  );
}

describe('StickerBubble', () => {
  it('shows a placeholder while resolving, then the image once ready', async () => {
    let resolve!: (url: string) => void;
    const resolveStickerUrl = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    renderSticker({ packId: 'ab', stickerId: 1, emoji: '🎉' }, { resolveStickerUrl });

    expect(screen.getByLabelText('🎉 sticker')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();

    act(() => {
      resolve('blob:sticker');
    });
    const img = await screen.findByRole('img', { name: '🎉 sticker' });
    expect(img).toHaveProperty('src', 'blob:sticker');
  });

  it('renders directly from an already-resolved url (the mock backend)', async () => {
    renderSticker({ packId: 'ab', stickerId: 1, url: 'data:image/svg+xml,x' }, {});
    const img = await screen.findByRole('img', { name: 'Sticker' });
    expect(img).toHaveProperty('src', 'data:image/svg+xml,x');
  });

  it('falls back to a muted emoji chip when the pack can’t be fetched and there’s no backup', async () => {
    const resolveStickerUrl = vi.fn().mockRejectedValue(new Error('not found'));
    renderSticker({ packId: 'ab', stickerId: 1, emoji: '🌸' }, { resolveStickerUrl });

    expect(await screen.findByText('Sticker')).toBeTruthy();
    expect(screen.getByText('🌸')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the history backup attachment when the pack fetch fails', async () => {
    const backupAttachment: Attachment = { id: 'history:a:1:sticker:0', contentType: 'image/webp' };
    const resolveStickerUrl = vi.fn().mockRejectedValue(new Error('pack unknown'));
    const resolveAttachmentUrl = vi.fn().mockResolvedValue('blob:backup');
    renderSticker(
      { packId: 'ab', stickerId: 1, backupAttachment },
      { resolveStickerUrl, resolveAttachmentUrl },
    );

    const img = await screen.findByRole('img', { name: 'Sticker' });
    expect(img).toHaveProperty('src', 'blob:backup');
    expect(resolveAttachmentUrl).toHaveBeenCalledWith(
      conversationId,
      backupAttachment,
      expect.anything(),
    );
  });

  it('falls back to the emoji chip when the backup attachment also fails', async () => {
    const backupAttachment: Attachment = { id: 'history:a:1:sticker:0', contentType: 'image/webp' };
    const resolveStickerUrl = vi.fn().mockRejectedValue(new Error('pack unknown'));
    const resolveAttachmentUrl = vi.fn().mockRejectedValue(new Error('expired'));
    renderSticker(
      { packId: 'ab', stickerId: 1, emoji: '🎈', backupAttachment },
      { resolveStickerUrl, resolveAttachmentUrl },
    );

    expect(await screen.findByText('Sticker')).toBeTruthy();
    expect(screen.getByText('🎈')).toBeTruthy();
  });

  it('logs the failing stage and error kind only, never ids or messages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const backupAttachment: Attachment = {
      id: 'history:secret-archive:77:sticker:0',
      contentType: 'image/webp',
    };
    const resolveStickerUrl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('pack deadbeef failed'), { kind: 'timeout' }));
    const resolveAttachmentUrl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('secret-archive gone'), { code: -32000 }));
    renderSticker(
      { packId: 'deadbeef', stickerId: 1, emoji: '🎈', backupAttachment },
      { resolveStickerUrl, resolveAttachmentUrl },
    );
    expect(await screen.findByText('Sticker')).toBeTruthy();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      '[ui] sticker download failed {"stage":"getSticker","kind":"timeout"}',
      '[ui] sticker download failed {"stage":"backup-attachment","kind":"rpc-error:-32000"}',
    ]);
    warn.mockRestore();
  });

  it('shows the fallback chip when a "ready" image fails to decode', async () => {
    const resolveStickerUrl = vi.fn().mockResolvedValue('blob:corrupt');
    renderSticker({ packId: 'ab', stickerId: 1 }, { resolveStickerUrl });

    const img = await screen.findByRole('img', { name: 'Sticker' });
    act(() => {
      fireEvent.error(img);
    });
    expect(await screen.findByText('Sticker')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('StickerBubble opening its pack', () => {
  it('is a plain image without an opener', async () => {
    renderSticker({ packId: 'ab', stickerId: 1, emoji: '🎉', url: 'data:image/svg+xml,x' }, {});
    expect(await screen.findByRole('img', { name: '🎉 sticker' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('becomes a labelled button that opens the pack, marked for the Vim "open" action', async () => {
    const onOpen = vi.fn();
    renderSticker(
      { packId: 'ab', stickerId: 1, emoji: '🎉', url: 'data:image/svg+xml,x' },
      {},
      onOpen,
    );
    const button = await screen.findByRole('button', { name: '🎉 sticker, view sticker pack' });
    expect(button.hasAttribute('data-open-attachment')).toBe(true);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is not a button while loading or when the sticker failed to load', async () => {
    const resolveStickerUrl = vi.fn().mockRejectedValue(new Error('gone'));
    renderSticker({ packId: 'ab', stickerId: 1, emoji: '🎈' }, { resolveStickerUrl }, vi.fn());
    expect(await screen.findByText('Sticker')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
