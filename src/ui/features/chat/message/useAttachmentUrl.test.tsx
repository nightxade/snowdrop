/**
 * The hook used to keep its own module-level URL cache (400 entries, never
 * revoked) on top of the backend's own `AttachmentResolver` cache
 * (src/core/backend/signal-cli/attachments.ts, 200 entries, revokes on
 * eviction). That let it serve a blob: URL the backend had already revoked
 * as "ready", with no way to retry. The fix removes the UI-level cache; this
 * checks that a remount (e.g. a row scrolling back into a virtualised list)
 * always asks the backend again instead of replaying a cached value.
 */
import { FeatureStore } from '@/core/backend/features';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId } from '@/core/domain';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { BACKFILL_MAX_OUTSTANDING } from './backfillGate';
import { ATTACHMENT_BACKFILL_TIMEOUT_MS, useAttachmentUrl } from './useAttachmentUrl';

afterEach(cleanup);

const conversationId = 'conv-1' as ConversationId;
const attachment: Attachment = { id: 'att-1', contentType: 'image/png' };
const message: MessageRef = { authorId: 'author-1', sentAt: 1_000 };

interface FakeBackend {
  resolveAttachmentUrl: (conversationId: ConversationId, attachment: Attachment) => Promise<string>;
  retainAttachmentUrl?: (attachment: Attachment) => void;
  releaseAttachmentUrl?: (attachment: Attachment) => void;
  requestAttachmentBackfill?: (
    conversationId: ConversationId,
    targetAuthorId: string,
    targetSentAt: number,
    attachmentIds: string[],
  ) => Promise<void>;
  capabilities?: FeatureStore;
}

function fakeApp(backend: FakeBackend): AppServices {
  return {
    backend: { kind: 'signal-cli', capabilities: new FeatureStore(), ...backend },
    stores: createStores(),
  } as unknown as AppServices;
}

function Probe() {
  const state = useAttachmentUrl(conversationId, message, attachment);
  const label =
    state.status === 'ready'
      ? `ready:${state.url}`
      : state.status === 'error'
        ? `error:${state.kind}`
        : state.status;
  return (
    <div>
      <div data-testid="state">{label}</div>
      <button type="button" onClick={state.retry}>
        retry
      </button>
      {state.fromPhone && (
        <button type="button" onClick={state.fromPhone}>
          from phone
        </button>
      )}
    </div>
  );
}

describe('useAttachmentUrl: no URL cache that can outlive the backend resolver', () => {
  it('asks the backend again on remount rather than replaying a stale cached URL', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:first')
      .mockResolvedValueOnce('blob:second');
    const app = fakeApp({ resolveAttachmentUrl });

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
    const app = fakeApp({ resolveAttachmentUrl });

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
    const app = fakeApp({ resolveAttachmentUrl });

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    expect(await screen.findByTestId('state')).toHaveProperty(
      'textContent',
      'error:download-failed',
    );
  });
});

describe('useAttachmentUrl: attachment backfill (patches/signal-cli, "0014")', () => {
  const backfillKey = `${message.authorId}\u0000${message.sentAt}`;
  /** `classifyAttachmentFailure` reads `kind`/`message`, duck-typed — not a real SignalCliError. */
  const missingOnDisk = { kind: 'user', message: 'Could not find attachment with ID: att-1' };

  const click = (name: string) => {
    act(() => {
      screen.getByRole('button', { name }).click();
    });
  };

  it('requests nothing on render, and exactly once per click', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValue(missingOnDisk);
    const requestAttachmentBackfill = vi.fn().mockResolvedValue(undefined);
    const app = fakeApp({
      resolveAttachmentUrl,
      requestAttachmentBackfill,
      capabilities: new FeatureStore(['attachmentBackfill']),
    });

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('error:missing-on-disk');
    expect(requestAttachmentBackfill).not.toHaveBeenCalled();

    // A fresh mount (e.g. a restart) asks nothing either.
    cleanup();
    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('error:missing-on-disk');
    expect(requestAttachmentBackfill).not.toHaveBeenCalled();

    click('from phone');
    await screen.findByText('backfilling');
    expect(requestAttachmentBackfill).toHaveBeenCalledTimes(1);
    expect(requestAttachmentBackfill).toHaveBeenCalledWith(
      conversationId,
      message.authorId,
      message.sentAt,
      [attachment.id],
    );
    expect(app.stores.local.getState().backfillRequested[backfillKey]).toBeDefined();
  });

  it('offers no phone action when the backend does not support it', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValue(missingOnDisk);
    const app = fakeApp({ resolveAttachmentUrl });
    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('error:missing-on-disk');
    expect(screen.queryByRole('button', { name: 'from phone' })).toBeNull();
  });

  it('a "ready" answer retries the download automatically', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValueOnce(missingOnDisk)
      .mockResolvedValueOnce('blob:recovered');
    const requestAttachmentBackfill = vi.fn().mockResolvedValue(undefined);
    const app = fakeApp({
      resolveAttachmentUrl,
      requestAttachmentBackfill,
      capabilities: new FeatureStore(['attachmentBackfill']),
    });

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('error:missing-on-disk');
    click('from phone');
    await screen.findByText('backfilling');

    act(() => {
      app.stores.session
        .getState()
        .setAttachmentBackfill(backfillKey, { status: 'ready', attachmentIds: [attachment.id] });
    });
    await screen.findByText('ready:blob:recovered');
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(2);
  });

  it('a "failed" answer settles on a backfill-specific error with a working Retry', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValue(missingOnDisk);
    const requestAttachmentBackfill = vi.fn().mockResolvedValue(undefined);
    const app = fakeApp({
      resolveAttachmentUrl,
      requestAttachmentBackfill,
      capabilities: new FeatureStore(['attachmentBackfill']),
    });

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('error:missing-on-disk');
    click('from phone');
    await screen.findByText('backfilling');

    act(() => {
      app.stores.session
        .getState()
        .setAttachmentBackfill(backfillKey, { status: 'failed', attachmentIds: [attachment.id] });
    });
    await screen.findByText('error:backfill-failed');

    // Retry asks the phone again even though this message was already asked once.
    act(() => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    await screen.findByText('backfilling');
    expect(requestAttachmentBackfill).toHaveBeenCalledTimes(2);
  });

  it('holds back clicks beyond the concurrency limit until an answer frees a place', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValue(missingOnDisk);
    const requestAttachmentBackfill = vi.fn().mockResolvedValue(undefined);
    const app = fakeApp({
      resolveAttachmentUrl,
      requestAttachmentBackfill,
      capabilities: new FeatureStore(['attachmentBackfill']),
    });
    const total = BACKFILL_MAX_OUTSTANDING + 2;
    const messages = Array.from({ length: total }, (_, i) => ({
      authorId: 'author-1',
      sentAt: 2_000 + i,
    }));
    function Many() {
      return (
        <>
          {messages.map((m) => (
            <One key={m.sentAt} message={m} />
          ))}
        </>
      );
    }
    function One({ message: m }: { message: MessageRef }) {
      const state = useAttachmentUrl(conversationId, m, attachment);
      return state.fromPhone ? (
        <button type="button" onClick={state.fromPhone}>
          {`ask ${m.sentAt}`}
        </button>
      ) : (
        <span>{`${m.sentAt} ${state.status}`}</span>
      );
    }
    render(
      <SnowdropContextProvider value={app}>
        <Many />
      </SnowdropContextProvider>,
    );
    await screen.findByRole('button', { name: 'ask 2000' });
    expect(requestAttachmentBackfill).not.toHaveBeenCalled();
    for (const m of messages) click(`ask ${m.sentAt}`);
    await act(async () => {
      await Promise.resolve();
    });
    // Every click shows the waiting state, but only the limit was sent.
    expect(screen.getAllByText(/backfilling$/u)).toHaveLength(total);
    expect(requestAttachmentBackfill).toHaveBeenCalledTimes(BACKFILL_MAX_OUTSTANDING);

    act(() => {
      app.stores.session
        .getState()
        .setAttachmentBackfill('author-1\u00002000', { status: 'failed', attachmentIds: [] });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(requestAttachmentBackfill).toHaveBeenCalledTimes(BACKFILL_MAX_OUTSTANDING + 1);
  });

  it('times out ~2 minutes after asking, with no answer at all', async () => {
    vi.useFakeTimers();
    try {
      const resolveAttachmentUrl = vi
        .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
        .mockRejectedValue(missingOnDisk);
      const requestAttachmentBackfill = vi.fn().mockResolvedValue(undefined);
      const app = fakeApp({
        resolveAttachmentUrl,
        requestAttachmentBackfill,
        capabilities: new FeatureStore(['attachmentBackfill']),
      });

      render(
        <SnowdropContextProvider value={app}>
          <Probe />
        </SnowdropContextProvider>,
      );
      await vi.waitFor(() => {
        expect(screen.getByTestId('state')).toHaveProperty('textContent', 'error:missing-on-disk');
      });
      click('from phone');
      await vi.waitFor(() => {
        expect(screen.getByTestId('state')).toHaveProperty('textContent', 'backfilling');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ATTACHMENT_BACKFILL_TIMEOUT_MS);
      });
      expect(screen.getByTestId('state')).toHaveProperty('textContent', 'error:backfill-timeout');
      expect(requestAttachmentBackfill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useAttachmentUrl: a failed backfill request', () => {
  const missingOnDisk = { kind: 'user', message: 'Could not find attachment with ID: att-1' };
  const click = (name: string) => {
    act(() => {
      screen.getByRole('button', { name }).click();
    });
  };

  it('leaves the spinner at once and Retry asks the phone again', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockRejectedValue(missingOnDisk);
    const requestAttachmentBackfill = vi
      .fn()
      .mockRejectedValueOnce(new Error('could not send'))
      .mockResolvedValue(undefined);
    const app = fakeApp({
      resolveAttachmentUrl,
      requestAttachmentBackfill,
      capabilities: new FeatureStore(['attachmentBackfill']),
    });

    render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('state')).toHaveProperty('textContent', 'error:missing-on-disk');
    });
    click('from phone');
    await vi.waitFor(() => {
      expect(screen.getByTestId('state')).toHaveProperty(
        'textContent',
        'error:backfill-send-failed',
      );
    });
    expect(requestAttachmentBackfill).toHaveBeenCalledTimes(1);

    click('retry');
    await vi.waitFor(() => {
      expect(requestAttachmentBackfill).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useAttachmentUrl: retain/release (keeps the backend from evicting an on-screen URL)', () => {
  it('retains on mount and releases on unmount, once each, regardless of retries', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValueOnce('blob:first')
      .mockResolvedValueOnce('blob:second');
    const retainAttachmentUrl = vi.fn();
    const releaseAttachmentUrl = vi.fn();
    const app = fakeApp({ resolveAttachmentUrl, retainAttachmentUrl, releaseAttachmentUrl });

    const { unmount } = render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('ready:blob:first');
    expect(retainAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(retainAttachmentUrl).toHaveBeenCalledWith(attachment);
    expect(releaseAttachmentUrl).not.toHaveBeenCalled();

    // A retry re-resolves through the backend, but it's still the same
    // mounted component holding the same claim — must not release and
    // re-retain in between (which would let an eviction elsewhere slip in
    // while this component still has the URL on screen).
    act(() => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    await screen.findByText('ready:blob:second');
    expect(retainAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(releaseAttachmentUrl).not.toHaveBeenCalled();

    unmount();
    expect(releaseAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(releaseAttachmentUrl).toHaveBeenCalledWith(attachment);
  });

  it('does nothing when the backend has no retain/release (e.g. attachments that always carry a url)', async () => {
    const resolveAttachmentUrl = vi
      .fn<(conversationId: ConversationId, attachment: Attachment) => Promise<string>>()
      .mockResolvedValue('blob:first');
    const app = fakeApp({ resolveAttachmentUrl });

    const { unmount } = render(
      <SnowdropContextProvider value={app}>
        <Probe />
      </SnowdropContextProvider>,
    );
    await screen.findByText('ready:blob:first');
    // Nothing to assert beyond "doesn't throw" — the fake backend has no
    // retainAttachmentUrl/releaseAttachmentUrl at all.
    unmount();
  });
});
