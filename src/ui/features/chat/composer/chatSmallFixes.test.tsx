/** Small composer behaviours: dismissed link previews, and a held Enter on a slash command. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { OutgoingLinkPreview } from '@/core/backend';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { Composer } from './Composer';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function setup(fetchPreview?: (url: string) => Promise<OutgoingLinkPreview | undefined>) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  if (fetchPreview) {
    snowdrop.stores.settings.getState().update('behaviour', { linkPreviews: true });
    (snowdrop as { linkPreviewFetch: typeof fetchPreview }).linkPreviewFetch = fetchPreview;
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
  const type = (value: string) => {
    fireEvent.change(input, { target: { value } });
  };
  return { snowdrop, input, type };
}

describe('link preview dismissal', () => {
  it('forgets a dismissed link once it is out of the text, so pasting it again previews it', async () => {
    const fetchPreview = vi.fn(() =>
      Promise.resolve({ url: 'https://example.com/a', title: 'Example' }),
    );
    const { type } = await setup(fetchPreview);
    type('https://example.com/a');
    await wait(900);
    const dismiss = screen.getByRole('button', { name: /remove|dismiss|close/iu });
    act(() => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByRole('button', { name: /remove|dismiss|close/iu })).toBeNull();
    // Sent or deleted: the link is gone from the text.
    type('');
    await wait(50);
    type('https://example.com/a');
    await wait(900);
    expect(screen.getByRole('button', { name: /remove|dismiss|close/iu })).toBeTruthy();
  });
});

describe('slash commands', () => {
  it('runs once when Enter is pressed again while it is still running', async () => {
    const { snowdrop, input, type } = await setup();
    let finish: () => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ type: 'done' }>((resolve) => {
          finish = () => {
            resolve({ type: 'done' });
          };
        }),
    );
    snowdrop.registries.slash.add({ name: 'slow', description: 'slow', owner: 'test', execute });
    type('/slow now');
    input.focus();
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await wait(0);
    expect(execute).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });
});
