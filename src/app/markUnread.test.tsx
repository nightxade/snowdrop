/**
 * "Mark as unread" end to end in the demo shell: a device-local flag that
 * shows as unread in the sidebar and rail, ends when the conversation is
 * opened or marked read, and sends nothing.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockBackend } from '@/core/backend/mock';
import { CoreCommand, NavCommand } from '@/core/commands';
import type { ConversationId } from '@/core/domain';
import { createMemoryStorage } from '@/core/persistence';
import { spacesSelectors, uiSelectors } from '@/core/stores';
import { App } from './App';
import { createSnowdrop, type Snowdrop } from './createSnowdrop';
import { SnowdropProvider } from './SnowdropProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function bootDemo() {
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  snowdrops.push(snowdrop);
  snowdrop.stores.settings.getState().update('connection', { mockLiveliness: false });
  render(
    <SnowdropProvider snowdrop={snowdrop}>
      <App />
    </SnowdropProvider>,
  );
  const demo = await screen.findByRole('button', { name: /Try the demo/u }, { timeout: 5000 });
  await act(async () => {
    fireEvent.click(demo);
    await Promise.resolve();
  });
  await act(async () => {
    await snowdrop.start();
    await snowdrop.sync.idle();
  });
  const mock = (await snowdrop.backendReady) as MockBackend;
  const { stores } = snowdrop;
  // Everything read, so the only unread thing is what the test flags.
  act(() => {
    for (const id of Object.keys(stores.conversations.getState().byId) as ConversationId[])
      stores.conversations.getState().setUnread(id, { count: 0, mentions: 0 });
  });
  const sent: { mock: { calls: unknown[] } }[] = [
    vi.spyOn(mock, 'markRead'),
    vi.spyOn(mock, 'send'),
    vi.spyOn(mock, 'setTyping'),
    vi.spyOn(mock, 'edit'),
    vi.spyOn(mock, 'react'),
  ];
  return { snowdrop, stores, sent };
}

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)!.closest('li')!;
const buttonFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)!;

/** An ordinary chat listed in Home (not a message request). */
function homeChat(): ConversationId {
  const li = [
    ...document.querySelectorAll<HTMLElement>('li[data-snowdrop="conversation-row"]'),
  ].find((row) => !row.hasAttribute('data-request') && !row.hasAttribute('data-blocked'))!;
  return li
    .querySelector('[data-conversation-id]')!
    .getAttribute('data-conversation-id') as ConversationId;
}

describe('mark as unread', () => {
  it('shows one menu item, whichever applies, flags the row and sends nothing', async () => {
    const { stores, sent } = await bootDemo();
    const id = homeChat();
    expect(rowFor(id).hasAttribute('data-unread')).toBe(false);

    fireEvent.contextMenu(buttonFor(id));
    expect(await screen.findByRole('menuitem', { name: 'Mark as unread' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Mark as read' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));

    expect(stores.local.getState().conversations[id]?.markedUnread).toBe(true);
    expect(rowFor(id).hasAttribute('data-unread')).toBe(true);
    expect(buttonFor(id).getAttribute('aria-label')).toMatch(/unread/u);
    expect(await screen.findByText('Conversation marked as unread')).toBeTruthy();

    fireEvent.contextMenu(buttonFor(id));
    expect(await screen.findByRole('menuitem', { name: 'Mark as read' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Mark as unread' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(stores.local.getState().conversations[id]?.markedUnread).toBeUndefined();
    expect(rowFor(id).hasAttribute('data-unread')).toBe(false);
    // The flag is local: no receipt, no message, no typing, no sync of any kind.
    expect(sent.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it('lights the rail tile of its space, and Home for a chat outside any space', async () => {
    const { stores } = await bootDemo();
    const spaceId = spacesSelectors.orderedIds(stores.spaces.getState())[0]!;
    const space = stores.spaces.getState().spaces[spaceId]!;
    const inSpace = space.categories.flatMap((c) => c.conversationIds)[0]!;
    const rail = document.querySelector<HTMLElement>('[data-snowdrop="rail"]')!;
    const tile = () =>
      within(rail)
        .getByRole('button', { name: new RegExp(`^${space.name}`, 'u') })
        .closest('[data-tone]')!;
    expect(tile().hasAttribute('data-unread')).toBe(false);
    act(() => {
      stores.local.getState().setMarkedUnread(inSpace, true);
    });
    expect(tile().hasAttribute('data-unread')).toBe(true);
    // Muted spaces stay quiet, like any other unread.
    act(() => {
      stores.spaces.getState().updateSpace(spaceId, { muted: true });
    });
    expect(tile().hasAttribute('data-unread')).toBe(false);
    act(() => {
      stores.spaces.getState().updateSpace(spaceId, { muted: false });
      stores.local.getState().setMarkedUnread(inSpace, false);
    });
    expect(tile().hasAttribute('data-unread')).toBe(false);

    const home = homeChat();
    const homeTile = () =>
      within(rail).getByRole('button', { name: /^Home/u }).closest('[data-tone]')!;
    expect(homeTile().hasAttribute('data-unread')).toBe(false);
    act(() => {
      stores.local.getState().setMarkedUnread(home, true);
    });
    expect(homeTile().hasAttribute('data-unread')).toBe(true);
  });

  it('is cleared by opening the chat, and stays while the chat is open until it is reopened', async () => {
    const { stores } = await bootDemo();
    const id = homeChat();
    act(() => {
      stores.local.getState().setMarkedUnread(id, true);
    });
    expect(rowFor(id).hasAttribute('data-unread')).toBe(true);
    await act(async () => {
      fireEvent.click(buttonFor(id));
      await Promise.resolve();
    });
    expect(uiSelectors.selectedConversation(stores.ui.getState())).toBe(id);
    expect(stores.local.getState().conversations[id]?.markedUnread).toBeUndefined();
    expect(rowFor(id).hasAttribute('data-unread')).toBe(false);

    // Marked while open (the palette command): it stays marked, still open.
    const { commands } = snowdropOf();
    await act(async () => {
      await commands.execute(NavCommand.MarkUnread);
    });
    expect(stores.local.getState().conversations[id]?.markedUnread).toBe(true);
    expect(uiSelectors.selectedConversation(stores.ui.getState())).toBe(id);
    expect(commands.get(NavCommand.MarkUnread)?.enabled?.()).toBe(false);

    // Open something else and come back: now it clears.
    const other = [...document.querySelectorAll<HTMLElement>('[data-conversation-id]')]
      .map((el) => el.getAttribute('data-conversation-id')!)
      .find((x) => x !== id && !rowFor(x).hasAttribute('data-request'))!;
    await act(async () => {
      fireEvent.click(buttonFor(other));
      await Promise.resolve();
    });
    expect(stores.local.getState().conversations[id]?.markedUnread).toBe(true);
    await act(async () => {
      fireEvent.click(buttonFor(id));
      await Promise.resolve();
    });
    expect(stores.local.getState().conversations[id]?.markedUnread).toBeUndefined();
    // Escape's command (mark read) also ends it.
    act(() => {
      stores.local.getState().setMarkedUnread(id, true);
    });
    await act(async () => {
      await snowdropOf().commands.execute(CoreCommand.MarkRead);
    });
    expect(stores.local.getState().conversations[id]?.markedUnread).toBeUndefined();
  });
});

function snowdropOf(): Snowdrop {
  return snowdrops[0]!;
}
