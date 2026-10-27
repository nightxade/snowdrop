import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { MockBackend } from '@/core/backend/mock';
import { bootDemo, disposeAll, settle, setViewport } from '@/test/bootDemo';

beforeEach(() => {
  setViewport(1440);
});
afterEach(async () => {
  cleanup();
  await disposeAll();
});

async function boot() {
  const snowdrop = await bootDemo();
  const mock = (await snowdrop.backendReady) as MockBackend;
  return { snowdrop, mock };
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};
const row = (id: string) =>
  document.querySelector<HTMLElement>(`button[data-conversation-id="${id}"]`);
const entry = () => screen.queryByRole('button', { name: /^Archived chats/u });
const list = () => document.querySelector<HTMLElement>('[data-snowdrop="conversation-list"]')!;

describe('archived chats in the sidebar', () => {
  it('lists the phone-archived chat under an entry at the bottom, not among the chats', async () => {
    const { snowdrop, mock } = await boot();
    const tavi = mock.world.conversationIds.get('dm-tavi')!;
    expect(snowdrop.stores.local.getState().conversations[tavi]?.archived).toBe(true);
    expect(row(tavi)).toBeNull();
    const button = entry()!;
    expect(button.textContent).toContain('1');
    // Last thing in the list.
    const nav = list().querySelector('nav')!;
    expect(nav.lastElementChild).toBe(button);
  });

  it('opens an Archived chats view with a way back, and the entry takes focus again on return', async () => {
    const { mock } = await boot();
    const tavi = mock.world.conversationIds.get('dm-tavi')!;
    await click(entry()!);
    const nav = screen.getByRole('navigation', { name: 'Archived chats' });
    expect(within(nav).getByRole('heading', { name: 'Archived chats' })).toBeTruthy();
    expect(within(nav).getByText(/will only appear in the list if new messages/u)).toBeTruthy();
    expect(row(tavi)).not.toBeNull();
    const back = within(nav).getByRole('button', { name: 'Back to conversations' });
    expect(document.activeElement).toBe(back);
    expect((await axe(nav, { rules: { region: { enabled: false } } })).violations).toEqual([]);
    await click(back);
    expect(row(tavi)).toBeNull();
    expect(document.activeElement).toBe(entry());
  });

  it('Unarchive in the view returns the chat to the list; the empty archive says so', async () => {
    const { snowdrop, mock } = await boot();
    const tavi = mock.world.conversationIds.get('dm-tavi')!;
    await click(entry()!);
    await click(within(row(tavi)!.closest('li')!).getByRole('button', { name: 'Unarchive' }));
    expect(snowdrop.stores.local.getState().conversations[tavi]?.archived).toBe(false);
    expect(screen.getByText('No archived chats')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Back to conversations' }));
    expect(row(tavi)).not.toBeNull();
    expect(entry()).toBeNull();
  });

  it('Archive from the row menu moves a chat under the entry and closes it if open', async () => {
    const { snowdrop, mock } = await boot();
    const ines = mock.world.conversationIds.get('dm-ines')!;
    await click(row(ines)!);
    expect(snowdrop.stores.ui.getState().selectedConversationBySpace.home).toBe(ines);
    act(() => {
      fireEvent.contextMenu(row(ines)!);
    });
    const menu = await screen.findByRole('menu');
    await click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    expect(row(ines)).toBeNull();
    expect(entry()!.textContent).toContain('2');
    expect(snowdrop.stores.ui.getState().selectedConversationBySpace.home).toBeUndefined();
    await click(entry()!);
    expect(row(ines)).not.toBeNull();
    act(() => {
      fireEvent.contextMenu(row(ines)!);
    });
    const again = await screen.findByRole('menu');
    expect(within(again).getByRole('menuitem', { name: 'Unarchive' })).toBeTruthy();
  });

  it('archiving a pinned chat unpins it', async () => {
    const { snowdrop, mock } = await boot();
    const ines = mock.world.conversationIds.get('dm-ines')!;
    snowdrop.stores.local.getState().setPinned(ines, true);
    await settle();
    act(() => {
      fireEvent.contextMenu(row(ines)!);
    });
    const menu = await screen.findByRole('menu');
    await click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    expect(snowdrop.stores.local.getState().conversations[ines]).toMatchObject({
      archived: true,
      pinned: false,
    });
  });

  it('a space has its own archive, holding only its own chats', async () => {
    const { snowdrop } = await boot();
    const spaces = snowdrop.stores.spaces.getState().spaces;
    const [space] = Object.values(spaces).filter((s) =>
      s.categories.some((c) => c.conversationIds.length > 0),
    );
    const id = space!.categories.flatMap((c) => c.conversationIds)[0]!;
    snowdrop.stores.local.getState().setArchived(id, true);
    expect(entry()!.textContent).toContain('1');
    act(() => {
      snowdrop.stores.ui.getState().selectSpace(space!.id);
    });
    await settle();
    expect(row(id)).toBeNull();
    expect(entry()!.textContent).toContain('1');
    await click(entry()!);
    expect(row(id)).not.toBeNull();
    // Leaving the space and coming back shows its list again, not the archive.
    act(() => {
      snowdrop.stores.ui.getState().selectSpace('home');
    });
    await settle();
    expect(screen.queryByRole('navigation', { name: 'Archived chats' })).toBeNull();
  });
});
