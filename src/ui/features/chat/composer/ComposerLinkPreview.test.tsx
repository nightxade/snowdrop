import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { OutgoingLinkPreview } from '@/core/backend';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { Composer } from './Composer';

// Real timers throughout (fake timers deadlock against React's own
// scheduler in this harness): short, generous margins around the
// composer's 600 ms debounce instead.
const DEBOUNCE_MS = 600;

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

function wait(ms: number): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

async function setup(fetchPreview: (url: string) => Promise<OutgoingLinkPreview | undefined>) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  snowdrop.stores.settings.getState().update('behaviour', { linkPreviews: true });
  // Simulates the desktop build; the real wiring (createSnowdrop.ts) is
  // `isTauri() ? desktopLinkPreviewFetch : null`.
  (snowdrop as { linkPreviewFetch: typeof fetchPreview }).linkPreviewFetch = fetchPreview;
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const chat = new ChatController();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={chat}>
      <Composer conversationId={conv.id} />
    </ChatControllerProvider>,
  );
  const input = screen.getByRole<HTMLTextAreaElement>('textbox');
  const typeText = (value: string) => {
    fireEvent.change(input, { target: { value } });
  };
  return { snowdrop, conv, input, typeText };
}

function lastOwnPreview(
  snowdrop: Snowdrop,
  conv: { id: Parameters<typeof messagesSelectors.list>[0] },
) {
  const selfId = snowdrop.stores.session.getState().self!.id;
  const message = messagesSelectors
    .list(conv.id)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId);
  return message?.previews?.[0];
}

describe('Composer: link preview', () => {
  it('debounces the fetch, and shows the resolved preview', async () => {
    const fetchPreview = vi
      .fn()
      .mockResolvedValue({ url: 'https://example.com/a', title: 'Example' });
    const { input, typeText } = await setup(fetchPreview);

    typeText('check this out https://example.com/a');
    await wait(DEBOUNCE_MS - 300);
    expect(fetchPreview).not.toHaveBeenCalled();

    await wait(300 + 200);
    expect(fetchPreview).toHaveBeenCalledExactlyOnceWith('https://example.com/a');
    expect(await screen.findByText('Example')).toBeTruthy();
    expect(input.value).toContain('https://example.com/a');
  }, 10_000);

  it('dismisses the card, which stays hidden for that url while composing', async () => {
    const fetchPreview = vi
      .fn()
      .mockResolvedValue({ url: 'https://example.com/a', title: 'Example' });
    const { typeText } = await setup(fetchPreview);

    typeText('https://example.com/a');
    await screen.findByText('Example', {}, { timeout: DEBOUNCE_MS + 2_000 });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove link preview' }));
    });
    expect(screen.queryByText('Example')).toBeNull();

    // Still composing the same url: stays dismissed, no re-fetch.
    typeText('https://example.com/a and more text');
    await wait(DEBOUNCE_MS + 200);
    expect(screen.queryByText('Example')).toBeNull();
    expect(fetchPreview).toHaveBeenCalledOnce();
  }, 10_000);

  it('ignores a stale response from an earlier url once a newer one is in flight', async () => {
    let resolveSlow!: (preview: OutgoingLinkPreview) => void;
    const fetchPreview = vi.fn((url: string) =>
      url === 'https://example.com/slow'
        ? new Promise<OutgoingLinkPreview>((resolve) => {
            resolveSlow = resolve;
          })
        : Promise.resolve({ url, title: 'Fast (current)' }),
    );
    const { typeText } = await setup(fetchPreview);

    typeText('https://example.com/slow');
    await wait(DEBOUNCE_MS + 200);
    expect(fetchPreview).toHaveBeenCalledWith('https://example.com/slow');

    // Edits the url before the slow fetch resolves.
    typeText('https://example.com/fast');
    await screen.findByText('Fast (current)', {}, { timeout: DEBOUNCE_MS + 2_000 });

    // The slow response lands well after; it must never overwrite the
    // current (different) url's preview.
    await act(async () => {
      resolveSlow({ url: 'https://example.com/slow', title: 'Slow (stale)' });
      await Promise.resolve();
    });
    expect(screen.queryByText('Slow (stale)')).toBeNull();
    expect(screen.getByText('Fast (current)')).toBeTruthy();
  }, 10_000);

  it('attaches the resolved preview to the sent message', async () => {
    const fetchPreview = vi.fn().mockResolvedValue({
      url: 'https://example.com/a',
      title: 'Example',
      description: 'A page.',
    });
    const { conv, snowdrop, input, typeText } = await setup(fetchPreview);

    typeText('look https://example.com/a');
    await screen.findByText('Example', {}, { timeout: DEBOUNCE_MS + 2_000 });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await vi.waitFor(() => {
      expect(lastOwnPreview(snowdrop, conv)).toBeDefined();
    });

    const preview = lastOwnPreview(snowdrop, conv);
    expect(preview).toMatchObject({
      url: 'https://example.com/a',
      title: 'Example',
      description: 'A page.',
    });
  }, 10_000);

  it('never fetches when the setting is off, even with a backend that could', async () => {
    const fetchPreview = vi
      .fn()
      .mockResolvedValue({ url: 'https://example.com/a', title: 'Example' });
    const { snowdrop, typeText } = await setup(fetchPreview);
    snowdrop.stores.settings.getState().update('behaviour', { linkPreviews: false });

    typeText('https://example.com/a');
    await wait(DEBOUNCE_MS + 200);
    expect(fetchPreview).not.toHaveBeenCalled();
    expect(screen.queryByText('Example')).toBeNull();
  }, 10_000);
});
