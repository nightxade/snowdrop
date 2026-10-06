/**
 * The hook used to keep its own module-level URL cache (400 entries, never
 * revoked) on top of the backend's own `AttachmentResolver` cache
 * (src/core/backend/signal-cli/attachments.ts, 200 entries, revokes on
 * eviction). That let it serve a blob: URL the backend had already revoked
 * as "ready", with no way to retry. The fix removes the UI-level cache; this
 * checks that a remount (e.g. a row scrolling back into a virtualised list)
 * always asks the backend again instead of replaying a cached value.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, ConversationId } from '@/core/domain';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { useAttachmentUrl } from './useAttachmentUrl';

afterEach(cleanup);

const conversationId = 'conv-1' as ConversationId;
const attachment: Attachment = { id: 'att-1', contentType: 'image/png' };

function fakeApp(
  resolveAttachmentUrl: (conversationId: ConversationId, attachment: Attachment) => Promise<string>,
): AppServices {
  return {
    backend: { kind: 'signal-cli', resolveAttachmentUrl },
  } as unknown as AppServices;
}

function Probe() {
  const state = useAttachmentUrl(conversationId, attachment);
  const label =
    state.status === 'ready'
      ? `ready:${state.url}`
      : state.status === 'error'
        ? `error:${state.message}`
        : state.status;
  return (
    <div>
      <div data-testid="state">{label}</div>
      <button type="button" onClick={state.retry}>
        retry
      </button>
    </div>
  );
}

describe('useAttachmentUrl: no URL cache that can outlive the backend resolver', () => {
  it('asks the backend again on remount rather than replaying a stale cached URL', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:first')
      .mockResolvedValueOnce('blob:second');
    const app = fakeApp(resolveAttachmentUrl);

    const { unmount } = render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('ready:blob:first');
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(1);

    // The row scrolls out and back in (a fresh mount) after the backend has
    // since evicted and revoked that URL. A UI-level cache would have
    // replayed "blob:first" with no further ask; asking again is correct.
    unmount();
    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('ready:blob:second');
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
  });

  it('retry() re-resolves through the backend rather than any cached value', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:first')
      .mockResolvedValueOnce('blob:second');
    const app = fakeApp(resolveAttachmentUrl);

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('ready:blob:first');

    act(() => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    await screen.findByText('ready:blob:second');
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejection as an error state with a retry, not a stuck "ready"', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValueOnce(new Error('Download failed'));
    const app = fakeApp(resolveAttachmentUrl);

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    expect(await screen.findByTestId('state')).toHaveProperty(
      'textContent',
      'error:Download failed',
    );
  });
});
