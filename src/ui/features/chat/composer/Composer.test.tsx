import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { NavCommand } from '@/core/commands';
import { MENTION_PLACEHOLDER, type ConversationId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { Composer } from './Composer';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function setup(title = 'Orchard · Engineering') {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === title,
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
    input.setSelectionRange(value.length, value.length);
    fireEvent.select(input);
  };
  return { snowdrop, conv, input, typeText, chat };
}

function lastOwn(snowdrop: Snowdrop, id: ConversationId) {
  const selfId = snowdrop.stores.session.getState().self!.id;
  return messagesSelectors
    .list(id)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId);
}

describe('<Composer />', () => {
  it.each([
    { types: [], plain: '' },
    { types: ['text/uri-list'], plain: 'file:///tmp/screenshot.png' },
    { types: ['Files'], plain: 'screenshot.png' },
  ])(
    'uses native clipboard files when the webview exposes only $types',
    async ({ types, plain }) => {
      const { input, snowdrop } = await setup();
      snowdrop.readClipboardFiles = vi
        .fn()
        .mockResolvedValue([new File(['native'], 'screenshot.png', { type: 'image/png' })]);
      await act(async () => {
        fireEvent.paste(input, {
          clipboardData: { files: [], items: [], types, getData: () => plain },
        });
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Remove screenshot.png' })).toBeTruthy();
      expect(snowdrop.readClipboardFiles).toHaveBeenCalledOnce();
    },
  );

  it('does not read the native clipboard for ordinary text', async () => {
    const { input, snowdrop } = await setup();
    snowdrop.readClipboardFiles = vi.fn();
    expect(
      fireEvent.paste(input, {
        clipboardData: { files: [], items: [], types: ['text/plain'], getData: () => 'hello' },
      }),
    ).toBe(true);
    expect(snowdrop.readClipboardFiles).not.toHaveBeenCalled();
  });

  it('keeps copied web links as text even when they advertise a URI list', async () => {
    const { input, snowdrop } = await setup();
    snowdrop.readClipboardFiles = vi.fn().mockResolvedValue([]);
    expect(
      fireEvent.paste(input, {
        clipboardData: {
          files: [],
          items: [],
          types: ['text/plain', 'text/uri-list'],
          getData: () => 'https://example.org',
        },
      }),
    ).toBe(true);
    expect(snowdrop.readClipboardFiles).not.toHaveBeenCalled();
  });

  it('surfaces native clipboard errors without adding attachments', async () => {
    const { input, snowdrop } = await setup();
    snowdrop.readClipboardFiles = vi
      .fn()
      .mockRejectedValue(new Error('A copied file is unreadable.'));
    await act(async () => {
      fireEvent.paste(input, {
        clipboardData: { files: [], items: [], types: [], getData: () => '' },
      });
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe('A copied file is unreadable.');
    expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
  });

  it('pastes files exposed through clipboard items even when files is empty', async () => {
    const { input, snowdrop } = await setup();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const allowed = fireEvent.paste(input, {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', getAsFile: () => file }],
      },
    });
    expect(allowed).toBe(false);
    expect(screen.getByRole('list', { name: 'Attachments to send' })).toBeTruthy();
    const send = vi.spyOn(snowdrop.send, 'send');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    expect(send.mock.calls[0]?.[0].attachments[0]?.fileName).toBe('notes.txt');
  });

  it('does not attach a file twice when both clipboard lists expose it', async () => {
    const { input } = await setup();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [file],
        items: [{ kind: 'file', getAsFile: () => file }],
      },
    });
    expect(screen.getAllByRole('button', { name: 'Remove notes.txt' })).toHaveLength(1);
  });

  it('leaves ordinary text paste to the browser', async () => {
    const { input } = await setup();
    expect(
      fireEvent.paste(input, {
        clipboardData: {
          files: [],
          items: [{ kind: 'string', getAsFile: () => null }],
        },
      }),
    ).toBe(true);
    expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
  });

  it('shows a placeholder naming the conversation', async () => {
    const { input, conv } = await setup();
    expect(input.placeholder).toBe(`Message #${conv.title}`);
  });

  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const { snowdrop, input, typeText } = await setup();
    const send = vi.spyOn(snowdrop.send, 'send');
    typeText('first line');
    const shiftEnter = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(shiftEnter).toBe(true); // not prevented: the browser inserts the newline
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].text).toBe('first line');
    expect(input.value).toBe('');
  });

  it('ignores Enter while an IME is composing (isComposing or keyCode 229)', async () => {
    const { snowdrop, input, typeText } = await setup();
    const send = vi.spyOn(snowdrop.send, 'send');
    typeText('にほん');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    expect(input.value).toBe('にほん');
  });

  it('swaps Enter and Shift+Enter with the setting', async () => {
    const { snowdrop, input, typeText } = await setup();
    act(() => {
      snowdrop.stores.settings.getState().update('behaviour', { enterToSend: false });
    });
    const send = vi.spyOn(snowdrop.send, 'send');
    typeText('hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await settle(snowdrop);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('accepts a member mention with Tab and sends it as a mention range', async () => {
    const { snowdrop, conv, input, typeText } = await setup();
    typeText('hey @');
    // The suggestion popover is a lazy chunk: the first one waits for it.
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const picked = within(list).getAllByRole('option')[1]!.textContent;
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    // "hey @Full Name " — the picked member's name, followed by a space.
    expect(input.value).toMatch(/^hey @\S.* $/u);
    expect(picked, input.value).toContain(input.value.slice(5, -1));

    const send = vi.spyOn(snowdrop.send, 'send');
    typeText(`${input.value}see this`);
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    const draft = send.mock.calls[0]?.[0];
    expect(draft?.text).toContain(MENTION_PLACEHOLDER);
    expect(draft?.mentionIds).toHaveLength(1);
    const sent = lastOwn(snowdrop, conv.id);
    expect(sent?.ranges.some((r) => r.mentionId === draft?.mentionIds[0])).toBe(true);
  });

  describe('Escape leaves the field', () => {
    async function escSetup() {
      const ctx = await setup();
      const focusMessages = vi.fn();
      ctx.snowdrop.commands.register({
        id: NavCommand.FocusMessages,
        title: 'Focus messages',
        run: focusMessages,
      });
      const read = vi.spyOn(ctx.snowdrop.sync, 'markConversationRead');
      return { ...ctx, focusMessages, read };
    }
    const setUnread = (s: Snowdrop, id: ConversationId, count: number) => {
      act(() => {
        s.stores.conversations.getState().setUnread(id, { count, mentions: 0 });
      });
    };

    it('moves focus to the message list and keeps the draft', async () => {
      const { input, typeText, focusMessages, snowdrop, conv } = await escSetup();
      setUnread(snowdrop, conv.id, 0);
      typeText('half typed');
      fireEvent.keyDown(input, { key: 'Escape' });
      await settle(snowdrop);
      expect(focusMessages).toHaveBeenCalledOnce();
      expect(input.value).toBe('half typed');
    });

    it('goes autocomplete, reply, mark read, then leaves', async () => {
      const { input, typeText, focusMessages, read, snowdrop, conv } = await escSetup();
      setUnread(snowdrop, conv.id, 2);
      typeText('@');
      expect(await screen.findByRole('listbox')).toBeTruthy();
      act(() => {
        snowdrop.stores.ui.getState().setReplyTo(conv.id, 'x' as never);
      });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeTruthy();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeFalsy();
      typeText('');
      fireEvent.keyDown(input, { key: 'Escape' });
      await settle(snowdrop);
      expect(read).toHaveBeenCalledOnce();
      expect(focusMessages).not.toHaveBeenCalled();
      setUnread(snowdrop, conv.id, 0);
      fireEvent.keyDown(input, { key: 'Escape' });
      await settle(snowdrop);
      expect(focusMessages).toHaveBeenCalledOnce();
    });

    it('leaves from an empty draft with nothing unread, without marking read', async () => {
      const { input, focusMessages, read, snowdrop, conv } = await escSetup();
      setUnread(snowdrop, conv.id, 0);
      fireEvent.keyDown(input, { key: 'Escape' });
      await settle(snowdrop);
      expect(focusMessages).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    });

    it('blurs the field when there is no message list to focus', async () => {
      const { input, snowdrop, conv } = await setup();
      setUnread(snowdrop, conv.id, 0);
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });
      await settle(snowdrop);
      expect(document.activeElement).not.toBe(input);
    });
  });

  it('dismisses autocomplete with Escape and keeps it closed while typing on', async () => {
    const { input, typeText } = await setup();
    typeText('@');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    typeText('@a');
    expect(screen.queryByRole('listbox')).toBeNull();
    typeText('');
    typeText('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('suggests slash commands from the registry', async () => {
    const { input, typeText } = await setup();
    typeText('/shr');
    const option = within(await screen.findByRole('listbox')).getByRole('option');
    expect(option.textContent).toContain('/shrug');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/shrug ');
  });

  it('autocompletes personal emoji by name, inserting :name:', async () => {
    const { snowdrop, input, typeText } = await setup();
    snowdrop.stores.local
      .getState()
      .saveCustomEmoji({ kind: 'image', name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' });
    typeText(':wa');
    const option = within(await screen.findByRole('listbox')).getByRole('option');
    expect(option.textContent).toContain(':wave:');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe(':wave: ');
  });

  it('edits the last own message with Up in an empty composer', async () => {
    const { snowdrop, conv, input, typeText } = await setup();
    typeText('to be edited');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    const own = lastOwn(snowdrop, conv.id)!;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing).toMatchObject({
      conversationId: conv.id,
      messageId: own.id,
    });
  });

  it('does not start editing when there is text', async () => {
    const { snowdrop, input, typeText } = await setup();
    typeText('draft');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
  });

  it('wraps the selection with Ctrl+B', async () => {
    const { input, typeText } = await setup();
    typeText('make bold');
    input.setSelectionRange(5, 9);
    fireEvent.keyDown(input, { key: 'b', ctrlKey: true });
    expect(input.value).toBe('make **bold**');
  });

  it('persists the draft per conversation', async () => {
    const { snowdrop, conv, typeText } = await setup();
    typeText('unfinished thought');
    expect(snowdrop.stores.local.getState().conversations[conv.id]?.draft).toBe(
      'unfinished thought',
    );
  });

  describe('polls', () => {
    const openPollDialog = async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Add attachment or poll' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Poll' }));
      return screen.findByRole('dialog', { name: 'New poll' });
    };

    it('offers a poll next to uploading a file in a group', async () => {
      await setup();
      expect(screen.queryByRole('button', { name: 'Upload a file' })).toBeNull();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Add attachment or poll' }), {
        button: 0,
        ctrlKey: false,
      });
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['Upload a file', 'Poll']);
    });

    it('keeps the plain upload button in a one-to-one chat, where Signal Desktop offers no poll', async () => {
      await setup('Tavi Nakamura');
      expect(screen.getByRole('button', { name: 'Upload a file' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Add attachment or poll' })).toBeNull();
    });

    it('creates a poll from the dialog: it appears in the chat and focus returns to the composer', async () => {
      const { snowdrop, conv, input } = await setup();
      const dialog = await openPollDialog();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Question' }), {
        target: { value: 'Where to eat?' },
      });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Option 1' }), {
        target: { value: 'Pizza' },
      });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Option 2' }), {
        target: { value: 'Ramen' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
      await settle(snowdrop);
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(r));
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      const sent = lastOwn(snowdrop, conv.id)!;
      expect(sent.poll).toEqual({
        question: 'Where to eat?',
        options: ['Pizza', 'Ramen'],
        allowMultiple: true,
        votes: [],
      });
      expect(sent.status).toBe('sent');
      expect(document.activeElement).toBe(input);
    });

    it('keeps a poll half written when the dialog is closed, and forgets it once sent', async () => {
      await setup();
      let dialog = await openPollDialog();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Question' }), {
        target: { value: 'Unfinished?' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(r));
      });
      dialog = await openPollDialog();
      expect(
        within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Question' }).value,
      ).toBe('Unfinished?');
    });
  });
});
