/**
 * Someone else's media in a message request (or a blocked chat) is not
 * fetched, decoded or opened until the user accepts, or asks for that one
 * item with "Download" — the media half of Signal Desktop's message
 * requests. Their own messages' media, and every accepted chat, load as
 * they always did.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageRef } from '@/core/backend';
import {
  directConversationId,
  type Attachment,
  type ConversationId,
  type LinkPreview,
} from '@/core/domain';
import { createStores, type Stores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { TooltipProvider } from '@/ui/primitives';
import { Attachments } from './Attachments';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MessageBody } from './MessageBody';
import { StickerBubble } from './StickerBubble';
import { resetReleasedMedia } from './useMediaHold';

const SELF = 'self-aci';
const STRANGER = 'stranger-aci';
const conversationId: ConversationId = directConversationId(STRANGER);
const fromStranger: MessageRef = { authorId: STRANGER, sentAt: 1_000 };
const fromSelf: MessageRef = { authorId: SELF, sentAt: 2_000 };

beforeEach(resetReleasedMedia);
afterEach(cleanup);

/** A signed-in app with one direct conversation with someone who isn't a contact. */
function requestApp(backend: Partial<AppServices['backend']>): {
  app: AppServices;
  stores: Stores;
} {
  const stores = createStores();
  stores.session.getState().setSelf({ id: SELF, name: 'Me', color: '#000', isSelf: true });
  stores.contacts.getState().upsert({ id: STRANGER, name: 'Marlowe', color: '#111' });
  stores.conversations.getState().upsert({
    id: conversationId,
    kind: 'direct',
    title: 'Marlowe',
    memberIds: [SELF, STRANGER],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: 1,
  });
  const app = { backend: { kind: 'signal-cli', ...backend }, stores } as unknown as AppServices;
  return { app, stores };
}

const wrap = (app: AppServices, ui: React.ReactNode) =>
  render(
    <SnowdropContextProvider value={app}>
      <TooltipProvider>{ui}</TooltipProvider>
    </SnowdropContextProvider>,
  );

const photo: Attachment = {
  id: 'photo-1',
  contentType: 'image/png',
  fileName: 'bowl.png',
  size: 2048,
};

describe('attachments in a message request', () => {
  it('holds a photo behind a Download button without asking the backend for it', async () => {
    const resolveAttachmentUrl = vi.fn().mockResolvedValue('blob:photo');
    const { app } = requestApp({ resolveAttachmentUrl });
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[photo]}
        pending={false}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    expect(screen.getByText(/Photo · 2.0 KB/u)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download bowl.png' }));
    await screen.findByRole('button', { name: /Open bowl\.png/u });
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  it('holds an attachment that already carries a url too (nothing is decoded before Download)', () => {
    const { app } = requestApp({});
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[{ ...photo, url: 'data:image/png;base64,AAAA' }]}
        pending={false}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download bowl.png' }));
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('keeps a downloaded photo shown when its row is remounted', () => {
    const { app } = requestApp({});
    const shown = { ...photo, url: 'data:image/png;base64,AAAA' };
    const ui = (
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[shown]}
        pending={false}
      />
    );
    const first = wrap(app, ui);
    fireEvent.click(screen.getByRole('button', { name: 'Download bowl.png' }));
    first.unmount();
    wrap(app, ui);
    expect(document.querySelector('img')).not.toBeNull();
  });

  it('resolves everything held as soon as the conversation is accepted', async () => {
    const resolveAttachmentUrl = vi.fn().mockResolvedValue('blob:photo');
    const { app, stores } = requestApp({ resolveAttachmentUrl });
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[photo]}
        pending={false}
      />,
    );
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    act(() => {
      stores.local.getState().markAccepted(conversationId, 1);
    });
    await screen.findByRole('button', { name: /Open bowl\.png/u });
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  it('holds a file as "not downloaded", with a download button', () => {
    const { app } = requestApp({});
    const file: Attachment = {
      id: 'f',
      contentType: 'application/pdf',
      fileName: 'rota.pdf',
      size: 4096,
    };
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[file]}
        pending={false}
      />,
    );
    expect(screen.getByText('4.0 KB · not downloaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download rota.pdf' })).toBeTruthy();
  });

  it('holds a blocked chat the same way', () => {
    const { app, stores } = requestApp({});
    stores.local.getState().markAccepted(conversationId, 1);
    stores.contacts
      .getState()
      .upsert({ id: STRANGER, name: 'Marlowe', color: '#111', blocked: true });
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[{ ...photo, url: 'blob:x' }]}
        pending={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Download bowl.png' })).toBeTruthy();
  });

  it('never holds the user’s own media, or any media in an accepted chat', () => {
    const { app, stores } = requestApp({});
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromSelf}
        attachments={[{ ...photo, url: 'blob:mine' }]}
        pending={false}
      />,
    );
    expect(document.querySelector('img')).not.toBeNull();
    cleanup();
    act(() => {
      stores.local.getState().markAccepted(conversationId, 1);
    });
    wrap(
      app,
      <Attachments
        conversationId={conversationId}
        message={fromStranger}
        attachments={[{ ...photo, url: 'blob:theirs' }]}
        pending={false}
      />,
    );
    expect(document.querySelector('img')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Download/u })).toBeNull();
  });
});

describe('link previews and links in a message request', () => {
  const preview: LinkPreview = {
    url: 'https://example.org/clay',
    title: 'Clay basics',
    image: { id: 'prev-1', contentType: 'image/png', width: 100, height: 100 },
  };
  const body = 'look: https://example.org/clay';

  it('shows the card without a link and without fetching its image', () => {
    const resolveAttachmentUrl = vi.fn().mockResolvedValue('blob:prev');
    const { app } = requestApp({ resolveAttachmentUrl });
    wrap(
      app,
      <LinkPreviewCard
        conversationId={conversationId}
        message={fromStranger}
        preview={preview}
        body={body}
      />,
    );
    expect(screen.getByText('Clay basics')).toBeTruthy();
    expect(document.querySelector('a')).toBeNull();
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
  });

  it('links the card and loads the image once accepted', async () => {
    const resolveAttachmentUrl = vi.fn().mockResolvedValue('blob:prev');
    const { app, stores } = requestApp({ resolveAttachmentUrl });
    wrap(
      app,
      <LinkPreviewCard
        conversationId={conversationId}
        message={fromStranger}
        preview={preview}
        body={body}
      />,
    );
    act(() => {
      stores.local.getState().markAccepted(conversationId, 1);
    });
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.org/clay');
    await vi.waitFor(() => {
      expect(resolveAttachmentUrl).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves web addresses in the text as plain text unless links are enabled', () => {
    const nameFor = () => 'x';
    const { container, rerender } = render(
      <MessageBody body={body} ranges={[]} selfId="me" nameFor={nameFor} linksEnabled={false} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe(body);
    rerender(<MessageBody body={body} ranges={[]} selfId="me" nameFor={nameFor} />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.org/clay');
  });
});

describe('stickers in a message request', () => {
  it('holds a sticker behind Download, then fetches it', async () => {
    const resolveStickerUrl = vi.fn().mockResolvedValue('blob:sticker');
    const { app } = requestApp({ resolveStickerUrl });
    wrap(
      app,
      <StickerBubble
        conversationId={conversationId}
        authorId={STRANGER}
        sticker={{ packId: 'ab', stickerId: 1, emoji: '🎉' }}
      />,
    );
    expect(resolveStickerUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download sticker' }));
    await vi.waitFor(() => {
      expect(document.querySelector('img[data-snowdrop="sticker"]')?.getAttribute('src')).toBe(
        'blob:sticker',
      );
    });
  });

  it('does not hold a sticker with no sender (the user’s own picker)', async () => {
    const resolveStickerUrl = vi.fn().mockResolvedValue('blob:sticker');
    const { app } = requestApp({ resolveStickerUrl });
    wrap(
      app,
      <StickerBubble conversationId={conversationId} sticker={{ packId: 'ab', stickerId: 1 }} />,
    );
    await vi.waitFor(() => {
      expect(resolveStickerUrl).toHaveBeenCalledTimes(1);
    });
  });
});
