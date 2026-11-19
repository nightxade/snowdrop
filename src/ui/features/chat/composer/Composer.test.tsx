import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { NavCommand } from '@/core/commands';
import {
  MAX_ATTACHMENT_BYTES,
  MENTION_PLACEHOLDER,
  applyDelete,
  pendingMessageId,
  type ConversationId,
} from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { Composer } from './Composer';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

// A one-to-one chat here is Beatrix Holm's: it has scripted messages, so it is always listed (a chat
// with only random demo activity may have none on a given day, and chats with no messages are hidden).
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
  const view = renderWithSnowdrop(
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
  return { snowdrop, conv, input, typeText, chat, view };
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

  it('refuses a too-large file with a message and keeps the rest of the drop', async () => {
    const { chat } = await setup();
    const huge = new File(['x'], 'movie.mov', { type: 'video/quicktime' });
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    const fine = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    act(() => {
      chat.addFiles([huge, fine]);
    });
    expect(screen.getByRole('alert').textContent).toBe(
      '\u201cmovie.mov\u201d is over 100 MB, so it can\u2019t be sent.',
    );
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy();
  });

  it('adds no attachment for an empty file, and counts many refused files', async () => {
    const { chat } = await setup();
    act(() => {
      chat.addFiles([new File([], 'blank.txt', { type: 'text/plain' })]);
    });
    expect(screen.getByRole('alert').textContent).toBe('\u201cblank.txt\u201d is empty.');
    expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
    act(() => {
      chat.addFiles(['a', 'b', 'c', 'd'].map((n) => new File([], `${n}.txt`)));
    });
    expect(screen.getByRole('alert').textContent).toBe('4 files are empty.');
    expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
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

  it('does not accept a suggestion on Ctrl+Tab, only on a plain Tab', async () => {
    const { input, typeText } = await setup();
    typeText('/shr');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Tab', ctrlKey: true });
    expect(input.value).toBe('/shr');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/shrug ');
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    'does not accept a suggestion on Enter with %o held',
    async (mod) => {
      const { input, typeText } = await setup();
      typeText('/shr');
      await screen.findByRole('listbox');
      fireEvent.keyDown(input, { key: 'Enter', ...mod });
      expect(input.value).not.toBe('/shrug ');
    },
  );

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

  it('opens the newest message that can be edited, skipping stickers and ones too old', async () => {
    const { snowdrop, conv, input, typeText } = await setup();
    typeText('fresh words');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    const text = lastOwn(snowdrop, conv.id)!;
    await act(async () => {
      await snowdrop.send.sendSticker({
        conversationId: conv.id,
        sticker: { packId: 'pack', stickerId: 1, emoji: '😀' },
      });
    });
    await settle(snowdrop);
    expect(lastOwn(snowdrop, conv.id)?.sticker).toBeDefined();
    // The sticker is the newest own message but has no text: the one before it is opened.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing).toMatchObject({ messageId: text.id });

    // Past the 24 hour window the old message is not offered, but a newer one that can be is.
    act(() => {
      snowdrop.stores.ui.getState().setEditing(null);
      snowdrop.stores.messages
        .getState()
        .update(conv.id, text.id, (m) => ({ ...m, sentAt: Date.now() - 2 * 24 * 3_600_000 }));
    });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing?.messageId).not.toBe(text.id);

    typeText('newer words');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    const newer = lastOwn(snowdrop, conv.id)!;
    expect(newer.id).not.toBe(text.id);
    // A sticker is last again: still skipped, and the newer text (not the old one) opens.
    await act(async () => {
      await snowdrop.send.sendSticker({
        conversationId: conv.id,
        sticker: { packId: 'pack', stickerId: 1, emoji: '😀' },
      });
    });
    await settle(snowdrop);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing).toMatchObject({ messageId: newer.id });
  });

  it('opens nothing on ArrowUp when every own message is past the window', async () => {
    const { snowdrop, conv, input, typeText } = await setup();
    typeText('only one');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    const only = lastOwn(snowdrop, conv.id)!;
    act(() => {
      const old = Date.now() - 2 * 24 * 3_600_000;
      const state = snowdrop.stores.messages.getState();
      for (const id of state.windows[conv.id]!.ids) {
        if (state.windows[conv.id]!.byId[id]?.authorId === only.authorId)
          state.update(conv.id, id, (m) => ({ ...m, sentAt: old }));
      }
    });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(snowdrop.stores.ui.getState().editing).toBeNull();
  });

  it("Esc on the reply bar's Cancel button cancels the reply and returns to the field", async () => {
    const { snowdrop, conv, input } = await setup();
    const target = messagesSelectors
      .list(conv.id)(snowdrop.stores.messages.getState())
      .findLast((m) => m.kind === 'normal' && !m.deleted)!;
    act(() => {
      snowdrop.stores.ui.getState().setReplyTo(conv.id, target.id);
    });
    const cancel = screen.getByRole('button', { name: 'Cancel reply (Esc)' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeFalsy();
    expect(screen.queryByRole('button', { name: 'Cancel reply (Esc)' })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('puts the words, the files and the reply back when a send throws', async () => {
    const { snowdrop, conv, input, typeText, chat } = await setup();
    const target = messagesSelectors
      .list(conv.id)(snowdrop.stores.messages.getState())
      .findLast((m) => m.kind === 'normal' && !m.deleted)!;
    act(() => {
      snowdrop.stores.ui.getState().setReplyTo(conv.id, target.id);
      chat.addFiles([new File(['x'], 'keep-me.txt', { type: 'text/plain' })]);
    });
    typeText('do not lose this');
    vi.spyOn(snowdrop.send, 'send').mockRejectedValueOnce(new Error('Storage is full'));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('Storage is full');
    expect(input.value).toBe('do not lose this');
    expect(screen.getByRole('button', { name: 'Remove keep-me.txt' })).toBeTruthy();
    expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBe(target.id);
    expect(snowdrop.stores.local.getState().conversations[conv.id]?.draft).toBe('do not lose this');
  });

  it('does not overwrite what was typed while a failing send was out', async () => {
    const { snowdrop, input, typeText } = await setup();
    typeText('first try');
    let fail!: (e: Error) => void;
    vi.spyOn(snowdrop.send, 'send').mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    typeText('second thought');
    await act(async () => {
      fail(new Error('nope'));
      await Promise.resolve();
    });
    await screen.findByRole('alert');
    expect(input.value).toBe('second thought');
  });

  it('leaves the failed message, not a restored draft, when the send fails after staging it', async () => {
    const { snowdrop, conv, input, typeText } = await setup();
    typeText('staged then thrown');
    vi.spyOn(snowdrop.send, 'send').mockImplementationOnce(() => {
      // As SendService does: the optimistic row is shown, then something rejects.
      const selfId = snowdrop.stores.session.getState().self!.id;
      act(() => {
        snowdrop.stores.messages.getState().appendLive({
          id: pendingMessageId('n1'),
          conversationId: conv.id,
          authorId: selfId,
          sentAt: Date.now(),
          receivedAt: Date.now(),
          body: 'staged then thrown',
          ranges: [],
          attachments: [],
          reactions: [],
          status: 'failed',
          kind: 'normal',
          nonce: 'n1',
        });
      });
      return Promise.reject(new Error('Storage is full'));
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('Storage is full');
    expect(input.value).toBe('');
  });

  it('brings the text back when a send comes back empty (a plugin emptied it)', async () => {
    const { snowdrop, input, typeText } = await setup();
    typeText('swallowed');
    vi.spyOn(snowdrop.send, 'send').mockResolvedValueOnce(null);
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(snowdrop);
    expect(input.value).toBe('swallowed');
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

  describe('buttons and the More options menu', () => {
    const openMore = () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More options' }), {
        button: 0,
        ctrlKey: false,
      });
    };
    const openPollDialog = async () => {
      openMore();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Poll' }));
      return screen.findByRole('dialog', { name: 'New poll' });
    };

    it('puts every button after the text field: Stickers, Emoji, then More options last', async () => {
      const { input } = await setup();
      const row = input.parentElement!;
      const kids = [...row.children].filter((el) => !el.matches('[hidden]'));
      expect(kids[0]).toBe(input);
      const names = kids
        .slice(1)
        .map((el) => el.getAttribute('aria-label'))
        .filter(Boolean);
      expect(names).toEqual(['Stickers', 'Emoji', 'More options']);
      // No separate plus or microphone button.
      expect(screen.queryByRole('button', { name: 'Upload a file' })).toBeNull();
      expect(screen.queryByRole('button', { name: /voice/iu })).toBeNull();
    });

    it('offers a file, a poll and a voice message in a group', async () => {
      await setup();
      openMore();
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((i) => i.textContent.replace(/\s*(Ctrl|Cmd|⌘|⌃).*$/u, ''))).toEqual([
        'Upload a file',
        'Poll',
        'Voice message',
      ]);
    });

    it('offers no poll in a one-to-one chat, where Signal Desktop has none', async () => {
      await setup('Beatrix Holm');
      openMore();
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((i) => i.textContent.replace(/\s*(Ctrl|Cmd|⌘|⌃).*$/u, ''))).toEqual([
        'Upload a file',
        'Voice message',
      ]);
    });

    it('leaves out the voice message while there is a draft to send', async () => {
      const { typeText } = await setup('Beatrix Holm');
      typeText('hello');
      openMore();
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['Upload a file']);
    });

    it('opens the file picker from Upload a file', async () => {
      await setup('Beatrix Holm');
      const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const click = vi.spyOn(picker, 'click').mockImplementation(() => undefined);
      openMore();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Upload a file' }));
      expect(click).toHaveBeenCalledOnce();
    });

    it('has no axe violations with the menu closed or open', async () => {
      const { view } = await setup();
      // jsdom has no `hidden` styling, so the (display: none) file input reads as an unlabelled field.
      view.container.querySelector('input[type="file"]')?.remove();
      const rules = { region: { enabled: false } };
      const ids = async (el: HTMLElement) => (await axe(el, { rules })).violations.map((v) => v.id);
      expect(await ids(view.container)).toEqual([]);
      openMore();
      await screen.findAllByRole('menuitem');
      // Radix hides the rest of the page from assistive tech while a menu is open, so check the menu itself.
      expect(await ids(screen.getByRole('menu'))).toEqual([]);
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
  describe('a reply whose message is gone', () => {
    async function replying() {
      const t = await setup();
      const target = messagesSelectors
        .list(t.conv.id)(t.snowdrop.stores.messages.getState())
        .findLast((m) => m.kind === 'normal' && !m.deleted && m.authorId !== 'self')!;
      act(() => {
        t.snowdrop.stores.ui.getState().setReplyTo(t.conv.id, target.id);
      });
      const bar = () => screen.queryByRole('button', { name: 'Cancel reply (Esc)' });
      expect(bar()).toBeTruthy();
      return { ...t, target, bar };
    }

    it('cancels the reply, and keeps the draft, when its message is removed', async () => {
      const { snowdrop, conv, target, typeText, input, bar } = await replying();
      typeText('still here');
      act(() => {
        snowdrop.stores.messages.getState().remove(conv.id, target.id);
      });
      expect(bar()).toBeNull();
      expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeUndefined();
      expect(input.value).toBe('still here');
    });

    it('cancels the reply when its message is deleted for everyone', async () => {
      const { snowdrop, conv, target, bar } = await replying();
      act(() => {
        snowdrop.stores.messages.getState().update(conv.id, target.id, (m) => applyDelete(m));
      });
      expect(bar()).toBeNull();
    });

    it('keeps the reply, and its quote, when its message only leaves the loaded window', async () => {
      const { snowdrop, conv, target, typeText, input, bar } = await replying();
      const send = vi.spyOn(snowdrop.send, 'send');
      await act(async () => {
        snowdrop.stores.messages.getState().closeWindow(conv.id);
        await Promise.resolve();
      });
      expect(bar()).toBeTruthy();
      expect(screen.getByText('Replying to').textContent).not.toContain('Unknown');
      typeText('far away');
      fireEvent.keyDown(input, { key: 'Enter' });
      await settle(snowdrop);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0].quote).toMatchObject({
        authorId: target.authorId,
        sentAt: target.sentAt,
      });
    });

    it('never sends without its quote while the bar shows a reply', async () => {
      const { snowdrop, conv, input, typeText } = await setup();
      const send = vi.spyOn(snowdrop.send, 'send');
      act(() => {
        snowdrop.stores.ui.getState().setReplyTo(conv.id, 'unknown-message' as never);
      });
      typeText('to nobody');
      fireEvent.keyDown(input, { key: 'Enter' });
      await settle(snowdrop);
      expect(send).not.toHaveBeenCalled();
      expect(snowdrop.stores.ui.getState().replyTo[conv.id]).toBeUndefined();
      expect(input.value).toBe('to nobody');
      expect(screen.getByRole('alert').textContent).toContain('cancelled');
    });
  });

  describe('suggestions follow the focused field', () => {
    it('closes when focus leaves the field, and waits for typing or the caret before reopening', async () => {
      const { input, typeText } = await setup();
      input.focus();
      typeText('@');
      expect(await screen.findByRole('listbox')).toBeTruthy();
      act(() => {
        input.blur();
      });
      expect(screen.queryByRole('listbox')).toBeNull();
      input.focus();
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.select(input);
      expect(screen.getByRole('listbox')).toBeTruthy();
    });

    it('stays shut for a draft that ends in a trigger until the user types', async () => {
      const { snowdrop, conv, chat, input, view } = await setup();
      snowdrop.stores.local.getState().setDraft(conv.id, 'hi @');
      view.unmount();
      renderWithSnowdrop(
        snowdrop,
        <ChatControllerProvider value={chat}>
          <Composer conversationId={conv.id} />
        </ChatControllerProvider>,
      );
      const back = screen.getByRole<HTMLTextAreaElement>('textbox');
      expect(back).not.toBe(input);
      expect(back.value).toBe('hi @');
      await settle(snowdrop);
      expect(screen.queryByRole('listbox')).toBeNull();
      back.focus();
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.change(back, { target: { value: 'hi @a' } });
      expect(await screen.findByRole('listbox')).toBeTruthy();
    });
  });

  /** Leaves the chat and comes back: a fresh composer over the same app. */
  function comeBack(t: Awaited<ReturnType<typeof setup>>) {
    cleanup();
    renderWithSnowdrop(
      t.snowdrop,
      <ChatControllerProvider value={t.chat}>
        <Composer conversationId={t.conv.id} />
      </ChatControllerProvider>,
    );
    return screen.getByRole<HTMLTextAreaElement>('textbox');
  }

  describe('the draft', () => {
    it('keeps staged files when the user leaves the chat and comes back', async () => {
      const t = await setup();
      t.typeText('with a file');
      act(() => {
        t.chat.addFiles([new File(['abc'], 'a.txt', { type: 'text/plain' })]);
      });
      const back = comeBack(t);
      expect(back.value).toBe('with a file');
      expect(screen.getByRole('button', { name: 'Remove a.txt' })).toBeTruthy();
      // Still sendable: the file goes out with the message.
      const send = vi.spyOn(t.snowdrop.send, 'send');
      fireEvent.keyDown(back, { key: 'Enter' });
      await settle(t.snowdrop);
      expect(send.mock.calls[0]?.[0].attachments.map((a) => a.fileName)).toEqual(['a.txt']);
      expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
      comeBack(t);
      expect(screen.queryByRole('list', { name: 'Attachments to send' })).toBeNull();
    });

    it('puts focus in the composer when a staged file is removed', async () => {
      const { input, chat } = await setup();
      act(() => {
        chat.addFiles([new File(['abc'], 'a.txt', { type: 'text/plain' })]);
      });
      const remove = screen.getByRole('button', { name: 'Remove a.txt' });
      remove.focus();
      fireEvent.click(remove);
      expect(document.activeElement).toBe(input);
    });

    it('sends the text without its leading and trailing blanks and empty lines', async () => {
      const { snowdrop, input, typeText } = await setup();
      const send = vi.spyOn(snowdrop.send, 'send');
      typeText('\n  hello\n\nworld \n\n');
      fireEvent.keyDown(input, { key: 'Enter' });
      await settle(snowdrop);
      expect(send.mock.calls[0]?.[0].text).toBe('hello\n\nworld');
    });

    it('sends no text with files when the body is only blanks, and nothing with neither', async () => {
      const { snowdrop, input, typeText, chat } = await setup();
      const send = vi.spyOn(snowdrop.send, 'send');
      typeText(' \n ');
      fireEvent.keyDown(input, { key: 'Enter' });
      await settle(snowdrop);
      expect(send).not.toHaveBeenCalled();
      act(() => {
        chat.addFiles([new File(['abc'], 'a.txt', { type: 'text/plain' })]);
      });
      fireEvent.keyDown(input, { key: 'Enter' });
      await settle(snowdrop);
      expect(send.mock.calls[0]?.[0]).toMatchObject({ text: '' });
      expect(send.mock.calls[0]?.[0].attachments).toHaveLength(1);
    });

    const nameOf = (t: Awaited<ReturnType<typeof setup>>) => {
      const selfId = t.snowdrop.stores.session.getState().self!.id;
      const id = t.conv.memberIds.find((m) => m !== selfId)!;
      return t.snowdrop.stores.contacts.getState().byId[id]!.name;
    };

    it('sends a typed @Name as plain text, and a restored draft as it was', async () => {
      const t = await setup();
      const send = vi.spyOn(t.snowdrop.send, 'send');
      t.typeText(`hey @${nameOf(t)}`);
      fireEvent.keyDown(t.input, { key: 'Enter' });
      await settle(t.snowdrop);
      expect(send.mock.calls[0]?.[0].mentionIds).toEqual([]);
      // A draft left with no mentions comes back with none (it is not worked out from the text).
      t.snowdrop.stores.local.getState().setDraft(t.conv.id, `again @${nameOf(t)}`);
      const back = comeBack(t);
      fireEvent.keyDown(back, { key: 'Enter' });
      await settle(t.snowdrop);
      expect(send.mock.calls[1]?.[0].mentionIds).toEqual([]);
    });

    it('keeps the mentions picked from the list with the draft', async () => {
      const t = await setup();
      t.typeText('hey @');
      const list = await screen.findByRole('listbox');
      expect(within(list).getAllByRole('option').length).toBeGreaterThan(0);
      fireEvent.keyDown(t.input, { key: 'Tab' });
      expect(
        t.snowdrop.stores.local.getState().conversations[t.conv.id]?.draftMentions,
      ).toHaveLength(1);
      const back = comeBack(t);
      const send = vi.spyOn(t.snowdrop.send, 'send');
      fireEvent.keyDown(back, { key: 'Enter' });
      await settle(t.snowdrop);
      expect(send.mock.calls[0]?.[0].mentionIds).toHaveLength(1);
    });

    it('forgets the picked mentions when the draft is emptied', async () => {
      const t = await setup();
      t.typeText('hey @');
      await screen.findByRole('listbox');
      fireEvent.keyDown(t.input, { key: 'Tab' });
      const label = t.input.value.trim();
      t.typeText('');
      t.typeText(label);
      const send = vi.spyOn(t.snowdrop.send, 'send');
      fireEvent.keyDown(t.input, { key: 'Enter' });
      await settle(t.snowdrop);
      expect(send.mock.calls[0]?.[0].mentionIds).toEqual([]);
    });
  });

  describe('Up on the message already being edited', () => {
    it('keeps the text typed in its editor', async () => {
      const t = await setup();
      t.typeText('to be edited');
      fireEvent.keyDown(t.input, { key: 'Enter' });
      await settle(t.snowdrop);
      const own = lastOwn(t.snowdrop, t.conv.id)!;
      const ui = t.snowdrop.stores.ui;
      act(() => {
        ui.getState().setEditing({ conversationId: t.conv.id, messageId: own.id });
        ui.getState().setEditDraft('half-written change');
      });
      const session = ui.getState().editing?.session;
      fireEvent.keyDown(t.input, { key: 'ArrowUp' });
      expect(ui.getState().editing).toMatchObject({
        messageId: own.id,
        draft: 'half-written change',
      });
      // Still a new session, which is what brings the editor focus.
      expect(ui.getState().editing?.session).not.toBe(session);
    });
  });

  describe('an edit open on a message that is deleted', () => {
    async function editingOwn() {
      const t = await setup();
      t.typeText('to be edited');
      fireEvent.keyDown(t.input, { key: 'Enter' });
      await settle(t.snowdrop);
      const own = lastOwn(t.snowdrop, t.conv.id)!;
      act(() => {
        t.snowdrop.stores.ui
          .getState()
          .setEditing({ conversationId: t.conv.id, messageId: own.id });
      });
      return { ...t, own };
    }

    it('closes, saying so, when it is deleted for everyone', async () => {
      const { snowdrop, conv, own } = await editingOwn();
      act(() => {
        snowdrop.stores.messages.getState().update(conv.id, own.id, (m) => applyDelete(m));
      });
      expect(snowdrop.stores.ui.getState().editing).toBeNull();
      expect(snowdrop.stores.ui.getState().toasts.map((x) => x.message)).toContain(
        'This message was deleted',
      );
    });

    it('closes, and focuses the composer, when the message is removed under the editor', async () => {
      const { snowdrop, conv, own, input } = await editingOwn();
      const editor = document.createElement('textarea');
      const row = document.createElement('div');
      row.setAttribute('data-message-id', own.id);
      row.append(editor);
      document.body.append(row);
      editor.focus();
      act(() => {
        snowdrop.stores.messages.getState().remove(conv.id, own.id);
      });
      expect(snowdrop.stores.ui.getState().editing).toBeNull();
      expect(document.activeElement).toBe(input);
      row.remove();
    });
  });
});
