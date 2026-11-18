/**
 * Keyboard focus lights a row up (C13). WebKitGTK can take focus off a row without a blur (a resize
 * that relays the list out), so the light must go out when focus turns up anywhere else.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

/** jsdom has no keyboard modality: count every focus as keyboard focus (`:focus-visible`). */
function focusIsKeyboardFocus() {
  const { value: matches } = Object.getOwnPropertyDescriptor(Element.prototype, 'matches') as {
    value: (this: Element, selector: string) => boolean;
  };
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':focus-visible' || matches.call(this, selector);
  });
}

async function renderRow() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const last = messagesSelectors.list(conv.id)(snowdrop.stores.messages.getState()).at(-1)!;
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={conv.id}
          id={last.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
      <button type="button">elsewhere</button>
    </ChatControllerProvider>,
  );
  return screen.getByRole('article');
}

describe('<MessageItem /> keyboard highlight', () => {
  it('goes out when focus turns up elsewhere without the row being blurred', async () => {
    focusIsKeyboardFocus();
    const row = await renderRow();
    act(() => {
      row.focus();
    });
    expect(row.hasAttribute('data-message-active')).toBe(true);

    // What WebKitGTK does after a relayout: focus arrives elsewhere and the row never hears a blur.
    act(() => {
      screen
        .getByRole('button', { name: 'elsewhere' })
        .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(row.hasAttribute('data-message-active')).toBe(false);
  });

  it('stays lit while focus moves inside the row', async () => {
    focusIsKeyboardFocus();
    const row = await renderRow();
    act(() => {
      row.focus();
    });
    const inner = row.querySelector<HTMLElement>('button');
    expect(inner).not.toBeNull();
    act(() => {
      inner!.focus();
    });
    expect(row.hasAttribute('data-message-active')).toBe(true);
  });
});
