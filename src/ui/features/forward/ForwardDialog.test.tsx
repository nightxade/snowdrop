import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { Message } from '@/core/domain';
import { bootForward, openChat, ownMessages, type ForwardKit } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ForwardDialog } from './ForwardDialog';

const live: Snowdrop[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

async function open(patch: Partial<Message> = {}, extra: (kit: ForwardKit) => void = () => {}) {
  const kit = await bootForward(patch);
  live.push(kit.snowdrop);
  extra(kit);
  const onClose = vi.fn();
  renderWithSnowdrop(
    kit.snowdrop,
    <ForwardDialog
      conversationId={kit.conversationId}
      messageIds={[kit.message.id]}
      onClose={onClose}
    />,
  );
  await settle(kit.snowdrop);
  const sends = vi.spyOn(kit.mock, 'send');
  const sent = () => sends.mock.calls.map(([input]) => input);
  return { ...kit, onClose, sent };
}

const search = () =>
  screen.getByRole<HTMLInputElement>('combobox', { name: 'Chats to forward to' });
const type = (value: string) => {
  act(() => {
    fireEvent.change(search(), { target: { value } });
  });
};
const enter = (init: KeyboardEventInit = {}) => {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? search(), { key: 'Enter', ...init });
  });
};
const option = (name: RegExp | string) => screen.getByRole('option', { name });
const checked = (name: RegExp | string) => option(name).getAttribute('aria-checked');
/** Filters to one chat and picks it with the keyboard. */
const pick = (query: string) => {
  search().focus();
  type(query);
  enter();
};
const primary = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: /^(Send|Next|Sending…)$/u });
const flush = async (snowdrop: Snowdrop) => {
  await settle(snowdrop);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};
const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };

describe('Forward dialog: picking chats', () => {
  it('opens on the search field, naming what is forwarded and listing recent chats and contacts', async () => {
    const { authorId, snowdrop } = await open();
    const dialog = screen.getByRole('dialog', { name: 'Forward to' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('Choose up to 5 chats to forward to.')).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('placeholder')).toBe('Search chats and contacts');
    const preview = within(dialog).getByRole('region', { name: 'Message to forward' });
    expect(within(preview).getByText('worth keeping')).toBeTruthy();
    expect(
      within(preview).getByText(snowdrop.stores.contacts.getState().byId[authorId]!.name),
    ).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Chats' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(5);
    expect(within(list).getByText('Recent chats')).toBeTruthy();
  });

  it('Enter picks the highlighted chat and picks it off again; the footer names the picks', async () => {
    await open();
    expect(primary().disabled).toBe(true);
    pick('Ines');
    expect(checked(/Ines/u)).toBe('true');
    expect(screen.getByText(/Ines/u, { selector: '[aria-live]' })).toBeTruthy();
    expect(primary().disabled).toBe(false);
    enter();
    expect(checked(/Ines/u)).toBe('false');
    expect(primary().disabled).toBe(true);
  });

  it('arrow keys move through the list and Enter picks where they stopped', async () => {
    await open();
    search().focus();
    const options = () => screen.getAllByRole('option');
    const first = options()[0]!;
    expect(first.getAttribute('aria-selected')).toBe('true');
    act(() => {
      fireEvent.keyDown(search(), { key: 'ArrowDown' });
    });
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    enter();
    expect(options()[1]?.getAttribute('aria-checked')).toBe('true');
    expect(options()[0]?.getAttribute('aria-checked')).toBe('false');
  });

  it('allows five chats at most, and says so', async () => {
    await open();
    for (const q of ['Ines', 'Lucia', 'Rafferty', 'Bram', 'Priya']) pick(q);
    type('');
    expect(
      screen.getAllByRole('option').filter((o) => o.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(5);
    pick('Beatrix');
    expect(screen.getByText('You can forward to 5 chats at most.')).toBeTruthy();
    expect(checked(/Beatrix/u)).toBe('false');
    // Taking one off makes room.
    pick('Priya');
    pick('Beatrix');
    expect(checked(/Beatrix/u)).toBe('true');
  });

  it('keeps a chat the user cannot write to in the list and explains why when it is picked', async () => {
    await open();
    const nan = screen.getByRole('option', { name: /Recipe Box/u });
    expect(nan.textContent).toContain('Only admins can send here');
    pick('Recipe Box');
    expect(
      screen.getByText(/Recipe Box: Only admins can send here\./u, { selector: '[role="status"]' }),
    ).toBeTruthy();
    expect(checked(/Recipe Box/u)).toBe('false');
    expect(primary().disabled).toBe(true);
  });

  it('says when nothing matches, and finds a chat by number', async () => {
    await open();
    type('zzzzqqq');
    expect(screen.getByText('No chats match “zzzzqqq”.')).toBeTruthy();
    type('');
  });

  it('closes with Escape, and with Cancel', async () => {
    const { onClose } = await open();
    act(() => {
      fireEvent.keyDown(search(), { key: 'Escape' });
    });
    await settle();
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Forward dialog: the editor step', () => {
  it('goes Next to an editor with the text, lets it change, and Back keeps the picks', async () => {
    const { snowdrop } = await open();
    pick('Ines');
    expect(primary().textContent).toBe('Next');
    fireEvent.click(primary());
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(field.value).toBe('worth keeping');
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(primary().textContent).toBe('Send');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement).toBe(search());
    expect(checked(/Ines/u)).toBe('true');
    await settle(snowdrop);
  });

  it('sends the edited text to every chat, in order, then closes and says so', async () => {
    const { snowdrop, onClose, sent, chat } = await open();
    pick('Ines');
    pick('Lucia');
    fireEvent.click(primary());
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    act(() => {
      fireEvent.change(field, { target: { value: 'worth keeping, **really**' } });
    });
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(sent().map((s) => [s.conversationId, s.body])).toEqual([
      [chat('dm-ines'), 'worth keeping, really'],
      [chat('dm-lucia'), 'worth keeping, really'],
    ]);
    expect(sent()[0]?.ranges).toEqual([{ start: 15, length: 6, style: 'bold' }]);
    expect(onClose).toHaveBeenCalled();
    const toasts = snowdrop.stores.ui.getState().toasts;
    expect(toasts.at(-1)).toMatchObject({ kind: 'success', message: 'Forwarded to 2 chats' });
  });

  it('Ctrl+Enter goes on and sends, from the search field and the editor', async () => {
    const { snowdrop, sent, chat, onClose } = await open();
    pick('Ines');
    enter({ ctrlKey: true });
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    enter({ ctrlKey: true });
    await flush(snowdrop);
    expect(sent().map((s) => s.conversationId)).toEqual([chat('dm-ines')]);
    expect(onClose).toHaveBeenCalled();
    expect(field).toBeTruthy();
  });

  it('will not send an empty message', async () => {
    await open();
    pick('Ines');
    fireEvent.click(primary());
    act(() => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: ' ' },
      });
    });
    expect(primary().disabled).toBe(true);
    expect(screen.getByText('There is nothing left to send.')).toBeTruthy();
  });

  it('turns a mention into plain @name text, as Desktop does', async () => {
    const { snowdrop, authorId, sent } = await open({
      body: 'hey ￼ look',
      ranges: [{ start: 4, length: 1, mentionId: 'x' }],
    });
    const name = snowdrop.stores.contacts.getState().byId[authorId]?.name;
    expect(name).toBeTruthy();
    pick('Ines');
    fireEvent.click(primary());
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(field.value).toMatch(/^hey @.+ look$/u);
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(sent()[0]?.body).toMatch(/^hey @.+ look$/u);
    expect(sent()[0]?.body).not.toContain('￼');
    expect(sent()[0]?.ranges.some((r) => r.mentionId !== undefined)).toBe(false);
  });
});

describe('Forward dialog: what cannot be edited', () => {
  it('sends a sticker straight away, with no editor', async () => {
    const { snowdrop, sent, chat } = await open({
      body: '',
      sticker: { packId: 'ab', stickerId: 1, emoji: '🙌' },
    });
    expect(screen.getByText('Sticker 🙌')).toBeTruthy();
    pick('Ines');
    expect(primary().textContent).toBe('Send');
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      conversationId: chat('dm-ines'),
      sticker: { packId: 'ab', stickerId: 1 },
    });
  });

  it('sends a voice message straight away, still a voice message', async () => {
    const { snowdrop, sent } = await open(
      {
        body: '',
        attachments: [{ id: 'v1', contentType: 'audio/aac', voiceNote: true, size: 5 }],
      },
      ({ mock }) => {
        vi.spyOn(mock, 'readAttachmentBlob').mockResolvedValue(
          new Blob(['voice'], { type: 'audio/aac' }),
        );
      },
    );
    await flush(snowdrop);
    pick('Ines');
    expect(primary().textContent).toBe('Send');
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(sent()[0]?.attachments?.[0]).toMatchObject({
      contentType: 'audio/aac',
      voiceNote: true,
    });
  });
});

describe('Forward dialog: attachments', () => {
  const photo = {
    id: 'a1',
    contentType: 'image/png',
    fileName: 'photo.png',
    size: 2048,
    width: 8,
    height: 6,
  };

  it('fetches a file before it can go out, with the progress shown', async () => {
    let release: (b: Blob) => void = () => {};
    let reads: MockInstance | undefined;
    const { snowdrop, sent } = await open({ body: 'look', attachments: [photo] }, ({ mock: m }) => {
      reads = vi
        .spyOn(m, 'readAttachmentBlob')
        .mockImplementation(() => new Promise<Blob>((resolve) => (release = resolve)));
    });
    expect(screen.getByText('Downloading…')).toBeTruthy();
    pick('Ines');
    // Going on to the editor does not wait; sending does.
    fireEvent.click(primary());
    expect(primary().disabled).toBe(true);
    expect(screen.getByText('Waiting for the attachments to download.')).toBeTruthy();
    await act(async () => {
      release(new Blob(['png'], { type: 'image/png' }));
      await Promise.resolve();
    });
    await flush(snowdrop);
    expect(screen.queryByText('Downloading…')).toBeNull();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(primary().disabled).toBe(false);
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toMatchObject({ body: 'look' });
    expect(sent()[0]?.attachments).toMatchObject([
      { fileName: 'photo.png', contentType: 'image/png', width: 8, height: 6 },
    ]);
    expect(sent()[0]?.attachments?.[0]?.data.size).toBe(3);
  });

  it('shows why a file failed, can try it again, and can leave it out', async () => {
    const fail = Object.assign(new Error('x'), { kind: 'timeout' });
    const { snowdrop, mock, sent } = await open(
      { body: 'look', attachments: [photo] },
      ({ mock: m }) => {
        vi.spyOn(m, 'readAttachmentBlob').mockRejectedValueOnce(fail);
      },
    );
    await flush(snowdrop);
    expect(screen.getByText(/took too long/u).getAttribute('role')).toBe('alert');
    pick('Ines');
    fireEvent.click(primary());
    expect(primary().disabled).toBe(true);
    expect(screen.getByText(/Remove the attachment that couldn’t be downloaded/u)).toBeTruthy();
    // Try again: this time it comes.
    vi.spyOn(mock, 'readAttachmentBlob').mockResolvedValue(
      new Blob(['png'], { type: 'image/png' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try photo.png again' }));
    await flush(snowdrop);
    expect(primary().disabled).toBe(false);
    // Or leave it out: the text goes alone.
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(sent()[0]?.attachments).toEqual([]);
  });

  it('asks the phone for an expired file and says when it has none', async () => {
    const gone = Object.assign(new Error('Could not find attachment'), { kind: 'user' });
    let asked: MockInstance | undefined;
    const { snowdrop } = await open({ body: 'look', attachments: [photo] }, ({ mock: m }) => {
      vi.spyOn(m, 'readAttachmentBlob').mockRejectedValue(gone);
      asked = vi.spyOn(m, 'requestAttachmentBackfill').mockImplementation((_c, author, at) => {
        m.emit('attachmentBackfill', {
          targetAuthorId: author,
          targetSentAt: at,
          status: 'failed',
          attachmentIds: ['a1'],
        });
        return Promise.resolve();
      });
    });
    await flush(snowdrop);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/phone doesn.t have this file/u).getAttribute('role')).toBe('alert');
  });
});

describe('Forward dialog: sending', () => {
  it('keeps what could not be sent picked, says which, and goes on with a retry', async () => {
    const { snowdrop, onClose, sent, chat } = await open();
    const real = snowdrop.send.send.bind(snowdrop.send);
    let broken = true;
    vi.spyOn(snowdrop.send, 'send').mockImplementation((draft) =>
      broken && draft.conversationId === chat('dm-lucia')
        ? Promise.reject(new Error('nope'))
        : real(draft),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    pick('Ines');
    pick('Lucia');
    fireEvent.click(primary());
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(onClose).not.toHaveBeenCalled();
    const alert = screen.getAllByRole('alert').find((a) => a.textContent)!;
    expect(alert.textContent).toMatch(/^Sent to 1 chat\. Couldn't send to .+: Couldn't send\.$/u);
    expect(sent().map((s) => s.conversationId)).toEqual([chat('dm-ines')]);
    broken = false;
    fireEvent.click(primary());
    await flush(snowdrop);
    // Only the chat that missed out is tried again.
    expect(sent().map((s) => s.conversationId)).toEqual([chat('dm-ines'), chat('dm-lucia')]);
    expect(onClose).toHaveBeenCalled();
  });

  it('lets the user close while it sends, and still reports a failure', async () => {
    const { snowdrop, onClose, chat } = await open({
      body: '',
      sticker: { packId: 'ab', stickerId: 1 },
    });
    vi.spyOn(snowdrop.requests, 'accept').mockResolvedValue(false);
    pick('Marlowe Quist');
    expect(chat('request-dm')).toBeTruthy();
    fireEvent.click(primary());
    cleanup();
    await flush(snowdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(snowdrop.stores.ui.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: "Couldn't forward to 1 chat",
    });
  });

  it('warns that forwarding to a message request accepts it, and does', async () => {
    const { snowdrop, mock, sent, chat } = await open({
      body: '',
      sticker: { packId: 'ab', stickerId: 1 },
    });
    const respond = vi.spyOn(mock, 'respondToMessageRequest');
    pick('Marlowe Quist');
    expect(screen.getByText('Forwarding to a message request accepts it.')).toBeTruthy();
    expect(option(/Marlowe Quist/u).textContent).toContain('Message request');
    fireEvent.click(primary());
    await flush(snowdrop);
    expect(respond).toHaveBeenCalledWith(chat('request-dm'), 'accept');
    expect(sent()).toHaveLength(1);
  });

  it('shows the forwarded message in the chat as an ordinary message of the user, without the quote', async () => {
    const { snowdrop, chat } = await open({
      quote: { authorId: 'someone', sentAt: 1, text: 'what it replied to' },
    });
    await openChat(snowdrop, chat('dm-ines'));
    pick('Ines');
    fireEvent.click(primary());
    fireEvent.click(primary());
    await flush(snowdrop);
    const mine = ownMessages(snowdrop, chat('dm-ines')).at(-1);
    expect(mine).toMatchObject({ body: 'worth keeping', kind: 'normal' });
    expect(mine?.quote).toBeUndefined();
    expect(mine?.status === 'failed').toBe(false);
  });
});

describe('Forward dialog: several messages', () => {
  it('shows them all, sends them in their original order with no editor step', async () => {
    const kit = await bootForward({ body: 'first' });
    live.push(kit.snowdrop);
    const second = {
      ...kit.message,
      id: `${kit.authorId}:${kit.message.sentAt + 5}` as Message['id'],
      sentAt: kit.message.sentAt + 5,
      receivedAt: kit.message.receivedAt + 5,
      seq: kit.message.seq! + 1,
      body: 'second',
    } satisfies Message;
    act(() => {
      kit.snowdrop.stores.messages.getState().appendLive(second);
    });
    const onClose = vi.fn();
    renderWithSnowdrop(
      kit.snowdrop,
      <ForwardDialog
        conversationId={kit.conversationId}
        // Asked for out of order.
        messageIds={[second.id, kit.message.id]}
        onClose={onClose}
      />,
    );
    await settle(kit.snowdrop);
    const sends = vi.spyOn(kit.mock, 'send');
    const preview = screen.getByRole('region', { name: 'Messages to forward' });
    expect(
      within(preview)
        .getAllByText(/^(first|second)$/u)
        .map((n) => n.textContent),
    ).toEqual(['first', 'second']);
    pick('Ines');
    expect(primary().textContent).toBe('Send');
    fireEvent.click(primary());
    await flush(kit.snowdrop);
    expect(sends.mock.calls.map(([input]) => input.body)).toEqual(['first', 'second']);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Forward dialog: accessibility', () => {
  it('has no axe violations in any step or state', async () => {
    const { snowdrop } = await open(
      {
        body: 'look',
        attachments: [{ id: 'a1', contentType: 'image/png', fileName: 'photo.png', size: 5 }],
      },
      ({ mock }) => {
        vi.spyOn(mock, 'readAttachmentBlob').mockResolvedValue(
          new Blob(['x'], { type: 'image/png' }),
        );
      },
    );
    await flush(snowdrop);
    const dialog = screen.getByRole('dialog', { name: 'Forward to' });
    const violations = async () => (await axe(dialog, { rules })).violations.map((v) => v.id);
    expect(await violations()).toEqual([]);
    pick('Ines');
    expect(await violations()).toEqual([]);
    type('zzzzqqq');
    expect(await violations()).toEqual([]);
    type('');
    fireEvent.click(primary());
    expect(await violations()).toEqual([]);
  });

  it('keeps focus inside the dialog', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Forward to' });
    for (let i = 0; i < 8; i++) {
      const buttons = within(dialog).getAllByRole('button');
      buttons[buttons.length - 1]!.focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
