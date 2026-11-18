import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { OutgoingLinkPreview } from '@/core/backend';
import type { Message } from '@/core/domain';
import { bootForward } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { RowState, RowStateProvider } from '../list/rowState';
import { MessageItem } from './MessageItem';

// Real timers (the link-preview debounce is 600 ms): short, generous margins around it.
const DEBOUNCE_MS = 600;
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const live: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

const URL_A = 'https://example.org/a';
const URL_B = 'https://example.net/b';

/** One message of ours in the demo group "crux", being edited in a row. */
async function editing(
  patch: Partial<Message> = {},
  fetchPreview?: (url: string) => Promise<OutgoingLinkPreview | undefined>,
) {
  const kit = await bootForward();
  live.push(kit.snowdrop);
  const { snowdrop, conversationId } = kit;
  const self = snowdrop.stores.session.getState().self!.id;
  snowdrop.stores.settings.getState().update('behaviour', { linkPreviews: true });
  if (fetchPreview)
    (snowdrop as { linkPreviewFetch: typeof fetchPreview }).linkPreviewFetch = fetchPreview;
  act(() => {
    snowdrop.stores.messages.getState().update(conversationId, kit.message.id, (m) => ({
      ...m,
      authorId: self,
      status: 'read',
      sentAt: Date.now() - 60_000,
      ...patch,
    }));
    snowdrop.stores.ui.getState().setEditing({ conversationId, messageId: kit.message.id });
  });
  const edit = vi.spyOn(snowdrop.send, 'edit').mockResolvedValue(true);
  const mount = () =>
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={new ChatController()}>
        <RowStateProvider value={new RowState()}>
          <div data-snowdrop="message-log">
            <MessageItem
              conversationId={conversationId}
              id={kit.message.id}
              continuation={false}
              compact={false}
              compactAvatars={false}
            />
          </div>
        </RowStateProvider>
      </ChatControllerProvider>,
    );
  const view = mount();
  await settle(snowdrop);
  const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit message' });
  const type = (value: string) => {
    fireEvent.change(field(), { target: { value } });
    field().setSelectionRange(value.length, value.length);
    fireEvent.select(field());
  };
  const save = () => {
    fireEvent.keyDown(field(), { key: 'Enter' });
  };
  return { snowdrop, kit, edit, view, mount, field, type, save };
}

describe('<MessageEditor />', () => {
  it('takes focus each time the same message is edited again', async () => {
    const { snowdrop, kit, field } = await editing({ body: 'hello' });
    const target = { conversationId: kit.conversationId, messageId: kit.message.id };
    expect(document.activeElement).toBe(field());
    act(() => {
      snowdrop.stores.ui.getState().setEditing(null);
    });
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    act(() => {
      snowdrop.stores.ui.getState().setEditing(target);
    });
    await settle(snowdrop);
    expect(document.activeElement).toBe(field());
  });

  it('keeps a mention picked while editing when the row is virtualised away and back', async () => {
    const { snowdrop, edit, mount, field, type, save } = await editing({ body: 'hello' });
    type('hello @');
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(0);
    fireEvent.keyDown(field(), { key: 'Tab' });
    const withMention = field().value;
    expect(withMention).toMatch(/^hello @\S.* $/u);

    // The list drops the row far from the viewport, then brings it back.
    cleanup();
    mount();
    await settle(snowdrop);
    expect(field().value).toBe(withMention);
    type(`${withMention}there`);
    save();
    expect(edit).toHaveBeenCalledTimes(1);
    // Sent as a real mention, not as plain "@Name" text.
    expect(edit.mock.calls[0]?.[3]).toHaveLength(1);
  });

  it('opens suggestions only from typing in the focused field', async () => {
    const { snowdrop, mount, field, type } = await editing({ body: 'hi @' });
    // The text it starts with ends in a trigger, but nothing has been typed.
    await settle(snowdrop);
    expect(screen.queryByRole('listbox')).toBeNull();
    type('hi @');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    act(() => {
      field().blur();
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    cleanup();
    mount();
    await settle(snowdrop);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  describe('a save that cannot go through', () => {
    it('keeps the editor and the text open, and says why, when the edit is refused', async () => {
      const { edit, field, type, save } = await editing({ body: 'hello' });
      edit.mockResolvedValue(false);
      type('hello, rewritten');
      save();
      expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't save the edit/u);
      expect(field().value).toBe('hello, rewritten');
      // Trying again is possible, and a success closes the editor.
      edit.mockResolvedValue(true);
      save();
      await vi.waitFor(() => {
        expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
      });
    });

    it('does the same when the edit throws', async () => {
      const { edit, field, type, save } = await editing({ body: 'hello' });
      edit.mockRejectedValue(new Error('boom'));
      type('hello again');
      save();
      expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't save the edit/u);
      expect(field().value).toBe('hello again');
    });

    it('says the window closed, without sending, when it did while the editor was open', async () => {
      const { snowdrop, kit, edit, field, type, save } = await editing({ body: 'hello' });
      type('hello, much later');
      act(() => {
        snowdrop.stores.messages.getState().update(kit.conversationId, kit.message.id, (m) => ({
          ...m,
          sentAt: Date.now() - 2 * 24 * 3_600_000,
        }));
      });
      save();
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Messages can only be edited for 24 hours.',
      );
      expect(edit).not.toHaveBeenCalled();
      expect(field().value).toBe('hello, much later');
    });
  });

  describe('link preview', () => {
    const preview = { url: URL_A, title: 'A page', description: 'About it' };
    const withPreview = { body: `read ${URL_A} please`, previews: [preview] };

    it('shows the message’s own card and lets the service send it again with the edit', async () => {
      const { edit, type, save } = await editing(withPreview);
      expect(screen.getByText('A page')).toBeTruthy();
      type(`read ${URL_A} now`);
      save();
      // Left out (undefined): the original's own preview goes again.
      expect(edit.mock.calls[0]?.slice(4)).toEqual([undefined]);
    });

    it('drops it when the link is removed from the text', async () => {
      const { edit, type, save } = await editing(withPreview);
      type('no link any more');
      expect(screen.queryByText('A page')).toBeNull();
      save();
      expect(edit.mock.calls[0]?.[4]).toBeNull();
    });

    it('drops it when the card is removed', async () => {
      const { edit, type, save } = await editing(withPreview);
      fireEvent.click(screen.getByRole('button', { name: 'Remove link preview' }));
      expect(screen.queryByText('A page')).toBeNull();
      type(`read ${URL_A} now`);
      save();
      expect(edit.mock.calls[0]?.[4]).toBeNull();
    });

    it('fetches a preview for a link the edit points to, and sends that', async () => {
      const fetched = { url: URL_B, title: 'Another page' };
      const fetchPreview = vi.fn().mockResolvedValue(fetched);
      const { edit, type, save } = await editing(withPreview, fetchPreview);
      type(`read ${URL_B} instead`);
      // Not the old card, and not yet the new one.
      expect(screen.queryByText('A page')).toBeNull();
      await wait(DEBOUNCE_MS + 200);
      expect(fetchPreview).toHaveBeenCalledWith(URL_B);
      expect(await screen.findByText('Another page')).toBeTruthy();
      save();
      expect(edit.mock.calls[0]?.[4]).toMatchObject(fetched);
    });

    it('sends none for a new link whose preview has not arrived', async () => {
      const fetchPreview = vi.fn().mockReturnValue(new Promise(() => undefined));
      const { edit, type, save } = await editing(withPreview, fetchPreview);
      type(`read ${URL_B} instead`);
      save();
      expect(edit.mock.calls[0]?.[4]).toBeNull();
    });

    it('keeps a removed card removed when the row is virtualised away and back', async () => {
      const { snowdrop, edit, mount, type, save } = await editing(withPreview);
      fireEvent.click(screen.getByRole('button', { name: 'Remove link preview' }));
      cleanup();
      mount();
      await settle(snowdrop);
      expect(screen.queryByText('A page')).toBeNull();
      type(`read ${URL_A} now`);
      save();
      expect(edit.mock.calls[0]?.[4]).toBeNull();
    });

    it('fetches and shows nothing for a message with files', async () => {
      const fetchPreview = vi.fn().mockResolvedValue({ url: URL_B, title: 'Another page' });
      const { type } = await editing(
        {
          body: 'caption',
          attachments: [{ id: 'a', contentType: 'image/png', fileName: 'x.png' }],
        },
        fetchPreview,
      );
      type(`caption ${URL_B}`);
      await wait(DEBOUNCE_MS + 200);
      expect(fetchPreview).not.toHaveBeenCalled();
      expect(screen.queryByText('Another page')).toBeNull();
      expect(screen.queryByText('Fetching a preview…')).toBeNull();
    });

    it('has no axe violations with the card showing', async () => {
      const { field } = await editing(withPreview);
      expect(screen.getByText('A page')).toBeTruthy();
      // The editor itself (the row's status mark is outside what changed).
      const editor = field().parentElement!;
      expect((await axe(editor, { rules: { region: { enabled: false } } })).violations).toEqual([]);
    });
  });
});
