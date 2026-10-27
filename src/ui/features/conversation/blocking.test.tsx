import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { directConversationId, type ConversationId } from '@/core/domain';
import { HOME } from '@/core/stores';
import { bootDemo, disposeAll, settle, setViewport } from '@/test/bootDemo';

beforeEach(() => {
  setViewport(1440);
});
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await disposeAll();
});

async function boot() {
  const snowdrop = await bootDemo();
  const mock = (await snowdrop.backendReady) as MockBackend;
  const dm = mock.world.conversationIds.get('dm-ines')!;
  // A group Home lists: not placed in any space.
  const placed = new Set(
    Object.values(snowdrop.stores.spaces.getState().spaces).flatMap((sp) =>
      sp.categories.flatMap((c) => c.conversationIds),
    ),
  );
  const group = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.kind === 'group' && !placed.has(c.id) && !c.left,
  )!.id;
  return { snowdrop, mock, dm, group };
}
const nameOf = (s: Snowdrop, id: ConversationId) =>
  s.stores.conversations.getState().byId[id]!.title;
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};
const noAxe = async (el: HTMLElement) => {
  const results = await axe(el);
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};
const rowButton = (id: string) =>
  document.querySelector<HTMLElement>(`button[data-conversation-id="${id}"]`)!;
async function rowMenu(id: string) {
  act(() => {
    fireEvent.contextMenu(rowButton(id));
  });
  return await screen.findByRole('menu');
}

describe('block and unblock from the sidebar menu', () => {
  it('asks first with Desktop wording, focuses Cancel, then blocks; the menu then offers Unblock', async () => {
    const { snowdrop, mock, dm } = await boot();
    const setBlocked = vi.spyOn(mock, 'setBlocked');
    const name = nameOf(snowdrop, dm);
    const menu = await rowMenu(dm);
    await click(within(menu).getByRole('menuitem', { name: 'Block' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const dialog = await screen.findByRole('dialog', { name: `Block ${name}?` });
    expect(
      within(dialog).getByText("Blocked people won't be able to call you or send you messages."),
    ).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancel');
    await noAxe(dialog);
    expect(setBlocked).not.toHaveBeenCalled();
    await click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() => {
      expect(setBlocked).toHaveBeenCalledWith(dm, true);
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    const peer = directConversationId(
      snowdrop.stores.conversations
        .getState()
        .byId[dm]!.memberIds.find((m) => m !== snowdrop.stores.session.getState().self!.id)!,
    );
    expect(peer).toBe(dm);
    const again = await rowMenu(dm);
    await click(within(again).getByRole('menuitem', { name: 'Unblock' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const confirm = await screen.findByRole('dialog', { name: `Unblock ${name}?` });
    expect(
      within(confirm).getByText('You will be able to message and call each other.'),
    ).toBeTruthy();
    await click(within(confirm).getByRole('button', { name: 'Unblock' }));
    await waitFor(() => {
      expect(setBlocked).toHaveBeenLastCalledWith(dm, false);
    });
  });

  it('cancelling the confirmation blocks nothing', async () => {
    const { mock, dm } = await boot();
    const setBlocked = vi.spyOn(mock, 'setBlocked');
    const menu = await rowMenu(dm);
    await click(within(menu).getByRole('menuitem', { name: 'Block' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(setBlocked).not.toHaveBeenCalled();
  });

  it('a group says Block and Leave, then blocks and leaves it, keeping the chat', async () => {
    const { snowdrop, mock, group } = await boot();
    const setBlocked = vi.spyOn(mock, 'setBlocked');
    const leave = vi.spyOn(mock, 'leaveGroup');
    const selfId = snowdrop.stores.session.getState().self!.id;
    // Make sure the user isn't its only admin, so it can be left.
    const world = mock.world.conversations.get(group)!;
    const extra = world.memberIds.find((m) => m !== selfId)!;
    const next = { ...world, adminIds: [...new Set([...world.adminIds, extra])] };
    mock.world.conversations.set(group, next);
    act(() => {
      snowdrop.stores.conversations.getState().upsert(next);
    });
    const title = nameOf(snowdrop, group);
    const menu = await rowMenu(group);
    await click(within(menu).getByRole('menuitem', { name: 'Block group' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const dialog = await screen.findByRole('dialog', { name: `Block and Leave ${title}?` });
    await click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() => {
      expect(leave).toHaveBeenCalledWith(group, []);
    });
    expect(setBlocked).toHaveBeenCalledWith(group, true);
    expect(snowdrop.stores.conversations.getState().byId[group]).toMatchObject({
      blocked: true,
      left: true,
    });
  });

  it('the only admin of a group is told to hand the role on first, and cannot block yet', async () => {
    const { snowdrop, mock, group } = await boot();
    const selfId = snowdrop.stores.session.getState().self!.id;
    const world = mock.world.conversations.get(group)!;
    const sole = {
      ...world,
      memberIds: [...new Set([selfId, ...world.memberIds])],
      adminIds: [selfId],
    };
    mock.world.conversations.set(group, sole);
    act(() => {
      snowdrop.stores.conversations.getState().upsert(sole);
    });
    const menu = await rowMenu(group);
    await click(within(menu).getByRole('menuitem', { name: 'Block group' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/only admin of this group/u)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Block' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('is not offered for yourself (Note to Self)', async () => {
    const { snowdrop } = await boot();
    const self = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct' && c.memberIds.length === 1,
    );
    if (!self) return;
    const menu = await rowMenu(self.id);
    expect(within(menu).queryByRole('menuitem', { name: 'Block' })).toBeNull();
  });
});

describe('block and unblock from the header details and the profile', () => {
  it('the details popover blocks the person, and then offers Unblock', async () => {
    const { snowdrop, dm } = await boot();
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(dm, HOME);
    });
    await settle();
    const header = document.querySelector<HTMLElement>('[data-snowdrop="chat-header"]')!;
    await click(header.querySelector<HTMLElement>('h1 button')!);
    const pop = await screen.findByRole('dialog', { name: /^About/u });
    await noAxe(pop);
    await click(within(pop).getByRole('button', { name: 'Block' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const dialog = await screen.findByRole('dialog', { name: /^Block /u });
    await click(within(dialog).getByRole('button', { name: 'Block' }));
    await settle();
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Blocked conversation' })).toBeTruthy();
    });
    await click(document.querySelector<HTMLElement>('[data-snowdrop="chat-header"] h1 button')!);
    expect(
      within(await screen.findByRole('dialog', { name: /^About/u })).getByRole('button', {
        name: 'Unblock',
      }),
    ).toBeTruthy();
  });

  it('a member row menu and the profile card offer Block for someone else, never for you', async () => {
    const { snowdrop, group } = await boot();
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(group, HOME);
    });
    await settle();
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    const rows = within(panel)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-snowdrop') === 'member-row');
    const other = rows.find((b) => !b.textContent.includes('(you)'))!;
    const me = rows.find((b) => b.textContent.includes('(you)'));
    act(() => {
      fireEvent.contextMenu(other);
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Block' })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(menu, { key: 'Escape' });
    });
    await settle();
    if (me) {
      act(() => {
        fireEvent.contextMenu(me);
      });
      const own = await screen.findByRole('menu');
      expect(within(own).queryByRole('menuitem', { name: 'Block' })).toBeNull();
    }
  });
});
