import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
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

async function setup() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
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
});
