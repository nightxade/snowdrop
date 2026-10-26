import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { Conversation } from '@/core/domain';
import { HOME } from '@/core/stores';
import { bootDemo, disposeAll, key, settle, setViewport } from '@/test/bootDemo';

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
  const selfId = snowdrop.stores.session.getState().self!.id;
  const groups = Object.values(snowdrop.stores.conversations.getState().byId).filter(
    (c) => c.kind === 'group',
  );
  return {
    snowdrop,
    selfId,
    admin: groups.find((c) => c.adminIds.includes(selfId) && c.requestingMemberIds?.length)!,
    member: groups.find(
      (c) => !c.adminIds.includes(selfId) && c.permissions?.editDetails === 'only-admins',
    )!,
    announcement: groups.find((c) => c.permissions?.sendMessages === 'only-admins')!,
  };
}
const current = (s: Snowdrop, c: Conversation) => s.stores.conversations.getState().byId[c.id]!;
const open = (s: Snowdrop, c: Conversation) => {
  act(() => {
    s.stores.ui.getState().selectConversation(c.id, HOME);
  });
};
const openModal = async (s: Snowdrop, type: string, props: Record<string, unknown>) => {
  act(() => {
    s.stores.ui.getState().openModal({ type, props });
  });
  await settle();
};
const noAxe = async (el: HTMLElement) => {
  const results = await axe(el);
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};
const dialog = () => screen.findByRole('dialog');

async function details(s: Snowdrop, c: Conversation) {
  open(s, c);
  await settle();
  const header = document.querySelector<HTMLElement>('[data-snowdrop="chat-header"]')!;
  await click(header.querySelector<HTMLElement>('h1 button')!);
  return await screen.findByRole('dialog', { name: `About ${c.title}` });
}

describe('group details popover', () => {
  it('offers an admin every group setting, and axe is clean', async () => {
    const { snowdrop, admin } = await boot();
    const pop = await details(snowdrop, admin);
    for (const name of ['Edit group', 'Add members', 'Group link', 'Permissions', 'Leave group'])
      expect(within(pop).getByRole('button', { name: new RegExp(name, 'u') })).toBeTruthy();
    await noAxe(pop);
  });

  it('hides what a plain member cannot do, but still lets them leave', async () => {
    const { snowdrop, member } = await boot();
    const pop = await details(snowdrop, member);
    for (const name of ['Edit group', 'Add members', 'Permissions'])
      expect(within(pop).queryByRole('button', { name: new RegExp(name, 'u') })).toBeNull();
    expect(within(pop).getByRole('button', { name: /Leave group/u })).toBeTruthy();
    await noAxe(pop);
  });

  it('opens the edit dialog from the popover and closes the popover', async () => {
    const { snowdrop, admin } = await boot();
    const pop = await details(snowdrop, admin);
    await click(within(pop).getByRole('button', { name: /Edit group/u }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await screen.findByRole('dialog', { name: 'Edit group' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /^About/u })).toBeNull();
  });
});

describe('announcement groups', () => {
  it('replaces the composer with a notice for a non-admin', async () => {
    const { snowdrop, announcement } = await boot();
    open(snowdrop, announcement);
    await settle();
    expect(document.querySelector('[data-snowdrop="composer"]')).toBeNull();
    expect(screen.getByText('Only admins can send messages in this group.')).toBeTruthy();
  });
});

describe('Edit group', () => {
  it('saves a new name and description and shows the system line; axe clean', async () => {
    const { snowdrop, admin } = await boot();
    await openModal(snowdrop, 'editGroup', { conversationId: admin.id });
    const d = await dialog();
    await noAxe(d);
    const name = within(d).getByRole<HTMLInputElement>('textbox', { name: 'Group name' });
    expect(document.activeElement).toBe(name);
    const save = within(d).getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    act(() => {
      fireEvent.change(name, { target: { value: 'Brand new name' } });
      fireEvent.change(within(d).getByRole('textbox', { name: 'Description' }), {
        target: { value: 'Fresh topic' },
      });
    });
    expect(save.disabled).toBe(false);
    await click(save);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(current(snowdrop, admin).title).toBe('Brand new name');
    expect(current(snowdrop, admin).description).toBe('Fresh topic');
  });

  it('caps the name at 32 characters and will not save an empty one', async () => {
    const { snowdrop, admin } = await boot();
    await openModal(snowdrop, 'editGroup', { conversationId: admin.id });
    const d = await dialog();
    const name = within(d).getByRole<HTMLInputElement>('textbox', { name: 'Group name' });
    act(() => {
      fireEvent.change(name, { target: { value: 'x'.repeat(50) } });
    });
    expect(name.value).toHaveLength(32);
    act(() => {
      fireEvent.change(name, { target: { value: '   ' } });
    });
    expect(within(d).getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('shows the refusal and keeps the dialog open when Signal says no', async () => {
    const { snowdrop, admin } = await boot();
    const mock = (await snowdrop.backendReady) as unknown as { failNext(): void };
    await openModal(snowdrop, 'editGroup', { conversationId: admin.id });
    const d = await dialog();
    act(() => {
      fireEvent.change(within(d).getByRole('textbox', { name: 'Group name' }), {
        target: { value: 'Will fail' },
      });
    });
    mock.failNext();
    await click(within(d).getByRole('button', { name: 'Save' }));
    expect((await within(d).findByRole('alert')).textContent).toMatch(/Check your connection/u);
    expect(current(snowdrop, admin).title).not.toBe('Will fail');
    await noAxe(d);
  });
});

describe('Add members', () => {
  it('lists contacts, fixes those already in, and adds the ones picked', async () => {
    const { snowdrop, admin, selfId } = await boot();
    const contacts = snowdrop.stores.contacts.getState().byId;
    const outsider = Object.values(contacts).find(
      (c) =>
        !c.isSelf &&
        c.id !== selfId &&
        !c.blocked &&
        !c.hidden &&
        !admin.memberIds.includes(c.id) &&
        !admin.pendingMemberIds?.includes(c.id) &&
        !admin.requestingMemberIds?.includes(c.id),
    )!;
    await openModal(snowdrop, 'addMembers', { conversationId: admin.id });
    const d = await dialog();
    await noAxe(d);
    const add = within(d).getByRole<HTMLButtonElement>('button', { name: 'Add members' });
    expect(add.disabled).toBe(true);
    const inGroup = admin.memberIds.find((m) => m !== selfId)!;
    const fixed = within(d).getByRole<HTMLInputElement>('checkbox', {
      name: new RegExp(contacts[inGroup]!.name.split(' ')[0]!, 'u'),
    });
    expect(fixed.disabled).toBe(true);
    await click(within(d).getByRole('checkbox', { name: new RegExp(outsider.name, 'u') }));
    expect(within(d).getByText('1 selected')).toBeTruthy();
    await click(within(d).getByRole('button', { name: 'Add 1 member' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(current(snowdrop, admin).memberIds).toContain(outsider.id);
  });
});

describe('Group link', () => {
  it('shows the link, copies it, resets it after asking, and turns it off', async () => {
    const { snowdrop, admin } = await boot();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openModal(snowdrop, 'groupLink', { conversationId: admin.id });
    const d = await dialog();
    await noAxe(d);
    const link = current(snowdrop, admin).inviteLink!;
    expect(within(d).getByTestId('group-link').textContent).toBe(link);
    expect(within(d).getByRole('img', { name: /QR code/u })).toBeTruthy();
    await click(within(d).getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(link);

    await click(within(d).getByRole('button', { name: 'Reset link' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset the group link?' });
    await noAxe(confirm);
    await click(within(confirm).getByRole('button', { name: 'Reset link' }));
    await waitFor(() => {
      expect(current(snowdrop, admin).inviteLink).not.toBe(link);
    });

    const again = await screen.findByRole('dialog', { name: 'Group link' });
    await click(within(again).getByRole('switch', { name: /Group link/u }));
    await waitFor(() => {
      expect(current(snowdrop, admin).inviteLink).toBeUndefined();
    });
    expect(within(again).queryByTestId('group-link')).toBeNull();
  });

  it('sets approval mode and is read-only for a non-admin', async () => {
    const { snowdrop, admin, member } = await boot();
    await openModal(snowdrop, 'groupLink', { conversationId: admin.id });
    const d = await dialog();
    const approve = within(d).getByRole('button', { name: 'An admin approves them' });
    expect(approve.getAttribute('aria-pressed')).toBe('false');
    await click(approve);
    await waitFor(() => {
      expect(approve.getAttribute('aria-pressed')).toBe('true');
    });
    act(() => {
      snowdrop.stores.ui.getState().closeModal();
    });
    await settle();
    await openModal(snowdrop, 'groupLink', { conversationId: member.id });
    const ro = await dialog();
    expect(within(ro).getByRole<HTMLInputElement>('switch').disabled).toBe(true);
  });
});

describe('Permissions', () => {
  it('changes a rule, with the old value kept until it lands', async () => {
    const { snowdrop, admin } = await boot();
    await openModal(snowdrop, 'groupPermissions', { conversationId: admin.id });
    const d = await dialog();
    await noAxe(d);
    const sel = within(d).getByRole<HTMLSelectElement>('combobox', {
      name: 'Who can send messages',
    });
    expect(sel.value).toBe('every-member');
    await act(async () => {
      fireEvent.change(sel, { target: { value: 'only-admins' } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(current(snowdrop, admin).permissions?.sendMessages).toBe('only-admins');
    });
    expect(sel.value).toBe('only-admins');
  });

  it('is disabled for a plain member', async () => {
    const { snowdrop, member } = await boot();
    await openModal(snowdrop, 'groupPermissions', { conversationId: member.id });
    const d = await dialog();
    for (const s of within(d).getAllByRole<HTMLSelectElement>('combobox'))
      expect(s.disabled).toBe(true);
  });
});

describe('Members panel', () => {
  it('lets an admin approve a request through a confirmation', async () => {
    const { snowdrop, admin } = await boot();
    open(snowdrop, admin);
    await settle();
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    expect(within(panel).getByRole('button', { name: 'Add members' })).toBeTruthy();
    const asking = admin.requestingMemberIds![0]!;
    const name = snowdrop.stores.contacts.getState().byId[asking]!.name;
    await noAxe(panel);
    await click(within(panel).getByRole('button', { name: `Approve request from ${name}` }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const confirm = await screen.findByRole('dialog', { name: `Approve request from ${name}?` });
    await noAxe(confirm);
    await click(within(confirm).getByRole('button', { name: 'Approve request' }));
    await waitFor(() => {
      expect(current(snowdrop, admin).memberIds).toContain(asking);
    });
    expect(
      within(panel).queryByRole('button', { name: `Approve request from ${name}` }),
    ).toBeNull();
  });

  it('hides requests and member actions from a non-admin', async () => {
    const { snowdrop, member } = await boot();
    open(snowdrop, member);
    await settle();
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    expect(within(panel).queryByRole('button', { name: 'Add members' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Approve request/u })).toBeNull();
  });

  it('offers make admin and remove from group in a member menu, and removes after asking', async () => {
    const { snowdrop, admin, selfId } = await boot();
    open(snowdrop, admin);
    await settle();
    const targetId = admin.memberIds.find((m) => m !== selfId && !admin.adminIds.includes(m))!;
    const name = snowdrop.stores.contacts.getState().byId[targetId]!.name;
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    const row = within(panel)
      .getAllByRole('button')
      .find(
        (b) => b.getAttribute('data-snowdrop') === 'member-row' && b.textContent.includes(name),
      )!;
    act(() => {
      fireEvent.contextMenu(row);
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Make admin' })).toBeTruthy();
    await click(within(menu).getByRole('menuitem', { name: 'Remove from group' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const confirm = await screen.findByRole('dialog', { name: `Remove ${name} from the group?` });
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(within(confirm).getByRole('button', { name: 'Remove from group' }));
    await waitFor(() => {
      expect(current(snowdrop, admin).memberIds).not.toContain(targetId);
    });
  });

  it('gives a plain member no admin entries in the menu', async () => {
    const { snowdrop, member, selfId } = await boot();
    open(snowdrop, member);
    await settle();
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    const row = within(panel)
      .getAllByRole('button')
      .find(
        (b) => b.getAttribute('data-snowdrop') === 'member-row' && !b.textContent.includes('(you)'),
      )!;
    expect(selfId).toBeTruthy();
    act(() => {
      fireEvent.contextMenu(row);
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Remove from group' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Make admin' })).toBeNull();
  });
});

describe('Leave group', () => {
  it('asks, then leaves: the chat stays, read-only, with the left notice', async () => {
    const { snowdrop, member } = await boot();
    open(snowdrop, member);
    await settle();
    await openModal(snowdrop, 'leaveGroup', { conversationId: member.id });
    const d = await dialog();
    await noAxe(d);
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(within(d).getByRole('button', { name: 'Leave group' }));
    await waitFor(() => {
      expect(current(snowdrop, member).left).toBe(true);
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-snowdrop="composer"]')).toBeNull();
    const notice = document.querySelector<HTMLElement>('[data-state="left"]')!;
    expect(notice.textContent).toBe('You are no longer a member of the group.');
    await noAxe(notice);
    await waitFor(async () => {
      expect((await snowdrop.repository.latest(member.id))?.systemText).toBe('You left the group.');
    });
    const panel = document.querySelector<HTMLElement>('[data-snowdrop="members"]')!;
    expect(within(panel).queryByRole('button', { name: 'Add members' })).toBeNull();
  });

  it('shows a left group no group actions, and no way to leave again', async () => {
    const { snowdrop, admin } = await boot();
    expect(await snowdrop.groups.create({ title: 'Gone', memberIds: [] })).toMatchObject({
      ok: true,
    });
    const made = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Gone',
    )!;
    expect(admin).toBeTruthy();
    expect(await snowdrop.groups.leave(made.id)).toBeNull();
    const pop = await details(snowdrop, current(snowdrop, made));
    for (const name of ['Edit group', 'Add members', 'Group link', 'Permissions', 'Leave group'])
      expect(within(pop).queryByRole('button', { name: new RegExp(name, 'u') })).toBeNull();
    expect(within(pop).getByText('You left this group')).toBeTruthy();
    await noAxe(pop);
  });

  it('makes the only admin choose a new admin first', async () => {
    const { snowdrop } = await boot();
    const made = await snowdrop.groups.create({
      title: 'Solo admin',
      memberIds: Object.values(snowdrop.stores.contacts.getState().byId)
        .filter((c) => !c.isSelf)
        .slice(0, 2)
        .map((c) => c.id),
    });
    if (!made.ok) throw new Error('create');
    await openModal(snowdrop, 'leaveGroup', { conversationId: made.id });
    const d = await dialog();
    await noAxe(d);
    const leave = within(d).getByRole<HTMLButtonElement>('button', { name: 'Leave group' });
    expect(leave.disabled).toBe(true);
    await click(within(d).getAllByRole('checkbox')[0]!);
    expect(leave.disabled).toBe(false);
    await click(leave);
    await waitFor(() => {
      expect(current(snowdrop, { id: made.id } as Conversation).left).toBe(true);
    });
  });
});

describe('New group', () => {
  it('starts from New message, picks members, names the group and opens it', async () => {
    const { snowdrop } = await boot();
    key({ key: 'n', code: 'KeyN', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Name, username or number' });
    expect(input).toBeTruthy();
    await click(await screen.findByRole('option', { name: /New group/u }));
    const d = await screen.findByRole('dialog', { name: 'New group' });
    await noAxe(d);
    const boxes = within(d).getAllByRole('checkbox');
    await click(boxes[0]!);
    await click(boxes[1]!);
    await click(within(d).getByRole('button', { name: 'Next' }));
    const named = await screen.findByRole('dialog', { name: 'Name this group' });
    await noAxe(named);
    const create = within(named).getByRole<HTMLButtonElement>('button', { name: 'Create group' });
    expect(create.disabled).toBe(true);
    act(() => {
      fireEvent.change(within(named).getByRole('textbox', { name: /Group name/u }), {
        target: { value: 'Fresh group' },
      });
    });
    await click(create);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const made = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Fresh group',
    )!;
    expect(made.memberIds).toHaveLength(3);
    expect(snowdrop.stores.ui.getState().selectedConversationBySpace[HOME]).toBe(made.id);
  });

  it('can go back to the members step', async () => {
    const { snowdrop } = await boot();
    await openModal(snowdrop, 'newGroup', {});
    const d = await dialog();
    await click(within(d).getByRole('button', { name: /^Next/u }));
    await click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'New group' })).toBeTruthy();
  });
});
