import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/core/persistence';
import { spacesSelectors, uiSelectors } from '@/core/stores';
import { App } from './App';
import { createShrike, type Shrike } from './createShrike';
import { ShrikeProvider } from './ShrikeProvider';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const shrikes: Shrike[] = [];

afterEach(async () => {
  cleanup();
  for (const h of shrikes.splice(0)) await h.dispose();
});

async function bootDemo(): Promise<Shrike> {
  const shrike = createShrike({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  shrikes.push(shrike);
  shrike.stores.settings.getState().update('connection', { mockLiveliness: false });
  render(
    <ShrikeProvider shrike={shrike}>
      <App />
    </ShrikeProvider>,
  );
  // First run: the welcome screen, then the demo.
  expect(await screen.findByRole('heading', { name: 'Shrike' }, { timeout: 5000 })).toBeTruthy();
  // The welcome screen is a lazy chunk: wait for it (outside act, so it can render).
  const demo = await screen.findByRole('button', { name: /Try the demo/u }, { timeout: 5000 });
  await act(async () => {
    fireEvent.click(demo);
    await Promise.resolve();
  });
  await act(async () => {
    await shrike.start();
    await shrike.sync.idle();
  });
  return shrike;
}

function key(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

describe('<App />', () => {
  it('goes from the welcome screen into the demo shell', async () => {
    const shrike = await bootDemo();
    expect(shrike.stores.settings.getState().connection.backend).toBe('mock');
    expect(document.querySelector('[data-shrike="rail"]')).not.toBeNull();
    const sidebar = document.querySelector<HTMLElement>('[data-shrike="sidebar"]')!;
    expect(within(sidebar).getByRole('region', { name: 'Direct Messages' })).toBeTruthy();
    expect(within(sidebar).getByRole('region', { name: 'Groups' })).toBeTruthy();
    // Every seeded space has a rail tile.
    const rail = document.querySelector<HTMLElement>('[data-shrike="rail"]')!;
    for (const id of spacesSelectors.orderedIds(shrike.stores.spaces.getState())) {
      const name = shrike.stores.spaces.getState().spaces[id]!.name;
      expect(within(rail).getByRole('button', { name: new RegExp(`^${name}`, 'u') })).toBeTruthy();
    }
  });

  it('shows unread and mention indicators on space tiles; muting keeps mentions only', async () => {
    const shrike = await bootDemo();
    const { stores } = shrike;
    const spaceId = spacesSelectors.orderedIds(stores.spaces.getState())[0]!;
    const space = stores.spaces.getState().spaces[spaceId]!;
    const convs = space.categories.flatMap((c) => c.conversationIds);
    act(() => {
      for (const c of convs)
        stores.conversations.getState().setUnread(c, { count: 0, mentions: 0 });
      stores.conversations.getState().setUnread(convs[0]!, { count: 2, mentions: 1 });
    });
    const tile = screen.getByRole('button', { name: `${space.name}, 1 mention` });
    const item = tile.closest('[data-tone]')!;
    expect(item.hasAttribute('data-unread')).toBe(true);
    expect(within(item as HTMLElement).getByText('1')).toBeTruthy();

    act(() => {
      stores.spaces.getState().updateSpace(spaceId, { muted: true });
    });
    expect(item.hasAttribute('data-unread')).toBe(false);
    expect(within(item as HTMLElement).getByText('1')).toBeTruthy();

    act(() => {
      stores.conversations.getState().setUnread(convs[0]!, { count: 2, mentions: 0 });
    });
    expect(screen.getByRole('button', { name: space.name })).toBeTruthy();
  });

  it('navigates by keyboard: Alt+↓, Alt+Shift+↓, Ctrl+Shift+M and Escape', async () => {
    const shrike = await bootDemo();
    const { stores } = shrike;
    const selected = () => uiSelectors.selectedConversation(stores.ui.getState());

    // Alt+↓ with nothing open picks the first row of the visible list.
    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    const first = selected();
    expect(first).not.toBeNull();
    const sidebar = document.querySelector<HTMLElement>('[data-shrike="sidebar"]')!;
    expect(within(sidebar).getByRole('button', { current: 'page' })).toBeTruthy();
    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(selected()).not.toBe(first);
    key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    expect(selected()).toBe(first);

    // Alt+Shift+↓ jumps to an unread conversation, switching space if needed.
    // A group inside the first space, so the jump has to switch spaces.
    const firstSpace = spacesSelectors.orderedIds(stores.spaces.getState())[0]!;
    const target = stores.spaces.getState().spaces[firstSpace]!.categories[0]!.conversationIds[0]!;
    await act(async () => {
      for (const c of Object.keys(stores.conversations.getState().byId))
        stores.conversations.getState().setUnread(c as typeof target, { count: 0, mentions: 0 });
      stores.local.getState().setMuted(target, false);
      stores.conversations.getState().setUnread(target, { count: 3, mentions: 1 });
      await Promise.resolve();
    });
    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true });
    expect(selected()).toBe(target);
    expect(stores.ui.getState().selectedSpace).toBe(firstSpace);

    // Ctrl+Shift+M toggles the member list.
    const before = stores.ui.getState().memberListOpen;
    key({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(stores.ui.getState().memberListOpen).toBe(!before);

    // Escape marks the open conversation read.
    stores.conversations.getState().setUnread(target, { count: 3, mentions: 1 });
    key({ key: 'Escape', code: 'Escape' });
    await act(async () => {
      await shrike.sync.idle();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(stores.conversations.getState().unread[target]?.count ?? 0).toBe(0);
  });

  it('arrow keys move focus between sidebar rows', async () => {
    await bootDemo();
    const rows = document.querySelectorAll<HTMLElement>(
      '[data-shrike="conversation-list"] [data-roving-item]',
    );
    expect(rows.length).toBeGreaterThan(3);
    act(() => {
      rows[1]!.focus();
    });
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: 'End' });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });
});
