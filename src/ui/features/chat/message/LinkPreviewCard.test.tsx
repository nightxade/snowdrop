import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId, LinkPreview } from '@/core/domain';
import { createLocalStore, createSessionStore } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { LinkPreviewCard } from './LinkPreviewCard';

afterEach(cleanup);

const conversationId = 'conv-1' as ConversationId;
const message: MessageRef = { authorId: 'author-1', sentAt: 1_000 };

function fakeApp(
  resolveAttachmentUrl: (
    conversationId: ConversationId,
    attachment: Attachment,
  ) => Promise<string> = vi.fn().mockResolvedValue('blob:preview-image'),
): AppServices {
  return {
    backend: { kind: 'signal-cli', resolveAttachmentUrl },
    stores: { session: createSessionStore(), local: createLocalStore() },
  } as unknown as AppServices;
}

function renderCard(preview: LinkPreview, body: string, app: AppServices = fakeApp()) {
  return render(
    <SnowdropContextProvider value={app}>
      <LinkPreviewCard
        conversationId={conversationId}
        message={message}
        preview={preview}
        body={body}
      />
    </SnowdropContextProvider>,
  );
}

describe('LinkPreviewCard', () => {
  it('renders the domain, title and description, linking to the url', () => {
    const preview: LinkPreview = {
      url: 'https://example.com/a',
      title: 'A great page',
      description: 'Some description text.',
    };
    renderCard(preview, 'check this out https://example.com/a');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('A great page')).toBeTruthy();
    expect(screen.getByText('Some description text.')).toBeTruthy();
  });

  it('strips "www." from the domain label', () => {
    renderCard({ url: 'https://www.example.com/a', title: 'T' }, 'https://www.example.com/a');
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('renders with missing title/description without crashing', () => {
    const { container } = renderCard({ url: 'https://example.com/a' }, 'https://example.com/a');
    expect(container.querySelector('a')).toBeTruthy();
  });

  it('hides the card when the preview url is not in the message text (Signal’s rule)', () => {
    const { container } = renderCard(
      { url: 'https://example.com/a', title: 'A' },
      'this text no longer mentions the link',
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides the card when the preview url is not http(s)', () => {
    const { container } = renderCard(
      // A malformed/non-http url should never reach a sender in practice, but
      // the card must still refuse to render it as a link.
      { url: 'javascript:alert(1)', title: 'evil' },
      'javascript:alert(1)',
    );
    expect(container.firstChild).toBeNull();
  });

  it('lays out a wide image full-width and a near-square image as a thumbnail', () => {
    const wide = renderCard(
      {
        url: 'https://example.com/a',
        image: { id: 'img-1', contentType: 'image/jpeg', width: 1200, height: 600 },
      },
      'https://example.com/a',
    );
    expect(wide.container.querySelector('[data-layout="wide"]')).toBeTruthy();
    cleanup();
    const thumb = renderCard(
      {
        url: 'https://example.com/b',
        image: { id: 'img-2', contentType: 'image/jpeg', width: 400, height: 400 },
      },
      'https://example.com/b',
    );
    expect(thumb.container.querySelector('[data-layout="thumb"]')).toBeTruthy();
  });
});
