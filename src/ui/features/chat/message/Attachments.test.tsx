/**
 * MediaTile used to flip a permanent local `broken` flag on an <img>'s
 * onError, with no way back: the Retry button only showed for the hook's
 * own `status === 'error'`, never for a `broken` tile — so a "ready" URL
 * the backend had since revoked (useAttachmentUrl.test.tsx covers why that
 * can happen) rendered as a dead, permanently stuck image. onError now
 * re-resolves through the hook (`state.retry()`) instead of a local flag,
 * so a genuine failure surfaces the hook's own error state and its Retry
 * button rather than a dead end.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId } from '@/core/domain';
import { createLocalStore, createSessionStore } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { TooltipProvider } from '@/ui/primitives';
import { Attachments } from './Attachments';

afterEach(cleanup);

const conversationId = 'conv-1' as ConversationId;
const message: MessageRef = { authorId: 'author-1', sentAt: 1_000 };

function fakeApp(
  resolveAttachmentUrl: (conversationId: ConversationId, attachment: Attachment) => Promise<string>,
): AppServices {
  return {
    backend: { kind: 'signal-cli', resolveAttachmentUrl },
    stores: { session: createSessionStore(), local: createLocalStore() },
  } as unknown as AppServices;
}

function renderTile(
  attachment: Attachment,
  resolveAttachmentUrl: (conversationId: ConversationId, attachment: Attachment) => Promise<string>,
) {
  return render(
    <SnowdropContextProvider value={fakeApp(resolveAttachmentUrl)}>
      <TooltipProvider>
        <Attachments
          conversationId={conversationId}
          message={message}
          attachments={[attachment]}
          pending={false}
        />
      </TooltipProvider>
    </SnowdropContextProvider>,
  );
}

describe('MediaTile: a dead "ready" URL re-resolves instead of sticking broken', () => {
  it('an <img> onError re-asks the backend, and shows Retry once that re-ask also fails', async () => {
    const image: Attachment = { id: 'att-img', contentType: 'image/png' };
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:dead')
      .mockRejectedValueOnce(new Error('Download failed'));
    renderTile(image, resolveAttachmentUrl);

    await screen.findByRole('button', { name: 'Open Image' });
    const img = document.querySelector('img');
    expect(img).toBeTruthy();

    // The URL that was "ready" turns out to be dead (e.g. revoked by the
    // backend resolver after this tile already rendered it).
    act(() => {
      fireEvent.error(img!);
    });

    // Re-resolved through the backend (not left as a permanently broken
    // image), and since that re-ask also fails, the error + Retry affordance
    // shows — matching a genuine `status: 'error'`, not a dead end.
    expect(await screen.findByText("Couldn't download")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);

    // The affordance actually works: a further retry can still recover.
    resolveAttachmentUrl.mockResolvedValueOnce('blob:fresh');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await screen.findByRole('button', { name: 'Open Image' });
    expect(document.querySelector('img')).toHaveProperty('src', 'blob:fresh');
  });

  it('a file that never loads settles on Retry instead of re-resolving forever', async () => {
    const image: Attachment = { id: 'att-corrupt', contentType: 'image/png' };
    // The backend keeps handing back the same (cached) URL for a corrupt file.
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValue('blob:corrupt');
    renderTile(image, resolveAttachmentUrl);

    await screen.findByRole('button', { name: 'Open Image' });
    act(() => {
      fireEvent.error(document.querySelector('img')!);
    });
    // One automatic re-resolve...
    await screen.findByRole('button', { name: 'Open Image' });
    act(() => {
      fireEvent.error(document.querySelector('img')!);
    });
    // ...then it stops and offers a manual retry.
    expect(await screen.findByText("Couldn't display")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
  });

  it('a <video> onError also re-asks the backend rather than staying stuck', async () => {
    const video: Attachment = { id: 'att-vid', contentType: 'video/mp4' };
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:dead-video')
      .mockResolvedValueOnce('blob:fresh-video');
    renderTile(video, resolveAttachmentUrl);

    await screen.findByRole('button', { name: 'Open Video' });
    const videoEl = document.querySelector('video');
    expect(videoEl).toBeTruthy();

    act(() => {
      fireEvent.error(videoEl!);
    });

    await screen.findByRole('button', { name: 'Open Video' });
    expect(document.querySelector('video')).toHaveProperty('src', 'blob:fresh-video');
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
  });
});

describe('attachment viewer', () => {
  it('re-resolves media errors in the open viewer and offers retry after failure', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('blob:thumbnail')
      .mockResolvedValueOnce('blob:viewer')
      .mockRejectedValueOnce(new Error('Unavailable'));
    renderTile({ id: 'photo', contentType: 'image/png', fileName: 'photo.png' }, resolve);
    fireEvent.click(await screen.findByRole('button', { name: 'Open photo.png' }));
    const dialog = await screen.findByRole('dialog');
    const image = await within(dialog).findByRole('img', { name: 'photo.png' });
    fireEvent.error(image);
    expect(await within(dialog).findByText("Couldn't download")).toBeTruthy();
    resolve.mockResolvedValueOnce('blob:recovered');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByRole('img', { name: 'photo.png' })).toHaveProperty(
      'src',
      'blob:recovered',
    );
  });

  it('opens media beyond the four-thumbnail limit through Next', async () => {
    const resolve = vi.fn((_id: ConversationId, a: Attachment) => Promise.resolve(`blob:${a.id}`));
    render(
      <SnowdropContextProvider value={fakeApp(resolve)}>
        <TooltipProvider>
          <Attachments
            conversationId={conversationId}
            message={message}
            pending={false}
            attachments={Array.from({ length: 5 }, (_, i) => ({
              id: `${i}`,
              fileName: `${i}.png`,
              contentType: 'image/png',
            }))}
          />
        </TooltipProvider>
      </SnowdropContextProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open 3.png, and 1 more' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByRole('img', { name: '4.png' })).toHaveProperty(
      'src',
      'blob:4',
    );
  });
});
