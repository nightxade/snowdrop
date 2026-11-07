import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { DropdownMenu } from '@/ui/primitives';
import { ModalHost } from './ModalHost';

const live: Snowdrop[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

async function host() {
  const snowdrop = await bootSnowdrop();
  live.push(snowdrop);
  const opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.append(opener);
  renderWithSnowdrop(snowdrop, <ModalHost />);
  const selfId = snowdrop.stores.session.getState().self!.id;
  const group = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.kind === 'group' && c.adminIds.includes(selfId),
  )!;
  return { snowdrop, opener, group };
}

const openModal = async (s: Snowdrop, type: string, props?: Record<string, unknown>) => {
  act(() => {
    s.stores.ui.getState().openModal({ type, ...(props ? { props } : {}) });
  });
  await settle(s);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};
const closeBy = async (s: Snowdrop, el: Element, init: KeyboardEventInit = { key: 'Escape' }) => {
  act(() => {
    fireEvent.keyDown(el, init);
  });
  await settle(s);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};
const press = async (s: Snowdrop, button: HTMLElement) => {
  act(() => {
    fireEvent.click(button);
  });
  await settle(s);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};

describe('ModalHost: focus follows a chain of dialogs', () => {
  it('moves focus into the dialog that replaces another, and back to the opener at the end', async () => {
    const { snowdrop, opener } = await host();
    opener.focus();
    await openModal(snowdrop, 'newMessage');
    const first = await screen.findByRole('dialog', { name: 'New message' });
    expect(first.contains(document.activeElement)).toBe(true);
    await openModal(snowdrop, 'newGroup');
    const second = await screen.findByRole('dialog', { name: 'New group' });
    // Not on <body>, and not on the old dialog's destroyed field.
    expect(second.contains(document.activeElement)).toBe(true);
    await closeBy(snowdrop, document.activeElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(snowdrop.stores.ui.getState().modal).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the opener through a dialog that swaps its own view (Reset link, then Cancel)', async () => {
    const { snowdrop, opener, group } = await host();
    opener.focus();
    await openModal(snowdrop, 'groupLink', { conversationId: group.id });
    const link = await screen.findByRole('dialog', { name: 'Group link' });
    await press(snowdrop, within(link).getByRole('button', { name: /Reset link/u }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset the group link?' });
    expect(confirm.contains(document.activeElement)).toBe(true);
    await press(snowdrop, within(confirm).getByRole('button', { name: 'Cancel' }));
    const back = await screen.findByRole('dialog', { name: 'Group link' });
    expect(back.contains(document.activeElement)).toBe(true);
    await press(snowdrop, within(back).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a dialog opened over another is a new one: focus moves in, and the opener survives', async () => {
    const { snowdrop, opener, group } = await host();
    opener.focus();
    await openModal(snowdrop, 'groupLink', { conversationId: group.id });
    const first = await screen.findByRole('dialog', { name: 'Group link' });
    await openModal(snowdrop, 'groupPermissions', { conversationId: group.id });
    expect(first.isConnected).toBe(false);
    const next = await screen.findByRole('dialog', { name: 'Permissions' });
    expect(next.contains(document.activeElement)).toBe(true);
    await closeBy(snowdrop, document.activeElement!);
    expect(document.activeElement).toBe(opener);
  });

  it('has no axe violations in the dialogs a chain passes through', async () => {
    const { snowdrop, group } = await host();
    const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };
    await openModal(snowdrop, 'newGroup');
    expect((await axe(await screen.findByRole('dialog'), { rules })).violations).toEqual([]);
    await openModal(snowdrop, 'groupLink', { conversationId: group.id });
    await screen.findByRole('dialog', { name: 'Group link' });
    expect((await axe(screen.getByRole('dialog'), { rules })).violations).toEqual([]);
  });
});

describe('ModalHost: a dialog whose subject is gone', () => {
  const missing = 'conversation-that-is-not-there';
  const cases: [string, Record<string, unknown>][] = [
    ['editGroup', { conversationId: missing }],
    ['addMembers', { conversationId: missing }],
    ['groupLink', { conversationId: missing }],
    ['groupPermissions', { conversationId: missing }],
    ['leaveGroup', { conversationId: missing }],
    ['groupMemberAction', { conversationId: missing, memberId: 'x', action: 'remove' }],
    ['blockConversation', { conversationId: missing }],
    ['editSpace', { spaceId: missing }],
    ['deleteSpace', { spaceId: missing }],
    ['editFolder', { folderId: missing }],
    ['forward', { messageIds: ['x'] }],
  ];
  it.each(cases)('%s closes and clears ui.modal', async (type, props) => {
    const { snowdrop } = await host();
    await openModal(snowdrop, type, props);
    await waitFor(() => {
      expect(snowdrop.stores.ui.getState().modal).toBeNull();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes a dialog whose group disappears while it is open', async () => {
    const { snowdrop, group, opener } = await host();
    opener.focus();
    await openModal(snowdrop, 'leaveGroup', { conversationId: group.id });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    act(() => {
      const { [group.id]: _gone, ...rest } = snowdrop.stores.conversations.getState().byId;
      snowdrop.stores.conversations.setState({ byId: rest });
    });
    await waitFor(() => {
      expect(snowdrop.stores.ui.getState().modal).toBeNull();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('dialogs that move between steps', () => {
  it('New group: Next goes to the name field and Back to the contact search', async () => {
    const { snowdrop } = await host();
    await openModal(snowdrop, 'newGroup');
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    const search = within(dialog).getByRole('searchbox', {
      name: 'Search contacts for the new group',
    });
    expect(document.activeElement).toBe(search);
    await press(snowdrop, within(dialog).getByRole('button', { name: /^Next/u }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Group name/u }));
    await press(snowdrop, screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Search contacts for the new group' }),
    );
  });

  it('Safety number changes: Review moves into the list, Done to the footer', async () => {
    const { snowdrop, group } = await host();
    const contactIds = Object.keys(snowdrop.stores.contacts.getState().byId).slice(0, 7);
    expect(contactIds.length).toBeGreaterThan(5);
    await openModal(snowdrop, 'safetyNumberChange', {
      conversationId: group.id,
      nonce: 'n1',
      contactIds,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    await press(snowdrop, within(dialog).getByRole('button', { name: 'Review' }));
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^View safety number/u);
    await press(snowdrop, screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };
    expect((await axe(screen.getByRole('dialog'), { rules })).violations).toEqual([]);
  });

  it('Safety number viewer: Back is in the footer, and focus lands in the dialog it opens', async () => {
    const { snowdrop, group, opener } = await host();
    opener.focus();
    const contactIds = Object.keys(snowdrop.stores.contacts.getState().byId).slice(0, 2);
    await openModal(snowdrop, 'safetyNumberChange', {
      conversationId: group.id,
      nonce: 'n2',
      contactIds,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    await press(
      snowdrop,
      within(dialog).getAllByRole('button', { name: /^View safety number/u })[0]!,
    );
    const viewer = await screen.findByRole('dialog', { name: 'Verify Safety Number' });
    // On a control of the viewer, not on the dialog container.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(viewer).getByRole('button', { name: /^(Mark as verified|Clear verification|OK)$/u }),
      );
    });
    const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };
    expect((await axe(viewer, { rules })).violations).toEqual([]);
    const back = within(viewer).getByRole('button', { name: 'Back' });
    expect(back.closest('footer')).not.toBeNull();
    await press(snowdrop, back);
    await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await closeBy(snowdrop, document.activeElement!);
    expect(document.activeElement).toBe(opener);
  });
});

describe('Group link', () => {
  it('turning the link off and on again keeps "an admin approves" when that was picked', async () => {
    const { snowdrop, group } = await host();
    const update = vi.spyOn(snowdrop.groups, 'update');
    await openModal(snowdrop, 'groupLink', { conversationId: group.id });
    await screen.findByRole('dialog', { name: 'Group link' });
    const toggle = () => screen.getByRole('switch', { name: /Group link/u });
    const linkOn = () => toggle().getAttribute('aria-checked') === 'true';
    if (!linkOn()) await press(snowdrop, toggle());
    await press(snowdrop, await screen.findByRole('button', { name: 'An admin approves them' }));
    await press(snowdrop, toggle());
    expect(linkOn()).toBe(false);
    await press(snowdrop, toggle());
    expect(update.mock.calls.at(-1)?.[1]).toEqual({ link: 'approval' });
  });
});

describe('ModalHost: a dialog opened from a surface that closes with it', () => {
  it('command palette to dialog: Escape returns to what had focus before the palette', async () => {
    const { snowdrop, opener } = await host();
    opener.focus();
    await openModal(snowdrop, 'switcher');
    await screen.findByRole('dialog');
    // What the palette does for a command: close itself, then run it.
    act(() => {
      snowdrop.stores.ui.getState().closeModal();
      snowdrop.stores.ui.getState().openModal({ type: 'newMessage' });
    });
    await screen.findByRole('dialog', { name: 'New message' });
    await closeBy(snowdrop, document.activeElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('menu item to dialog: Escape returns to the menu trigger, not the page body', async () => {
    const snowdrop = await bootSnowdrop();
    live.push(snowdrop);
    renderWithSnowdrop(
      snowdrop,
      <>
        <DropdownMenu
          label="Options"
          entries={() => [
            {
              kind: 'item',
              id: 'shortcuts',
              label: 'Keyboard shortcuts',
              onSelect: () => {
                snowdrop.stores.ui.getState().openModal({ type: 'shortcuts' });
              },
            },
          ]}
        >
          <button type="button">Options</button>
        </DropdownMenu>
        <ModalHost />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Options' });
    trigger.focus();
    act(() => {
      fireEvent.keyDown(trigger, { key: 'Enter' });
      fireEvent.click(trigger);
    });
    const item = await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' });
    act(() => {
      item.focus();
      fireEvent.click(item);
    });
    await screen.findByRole('dialog');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await closeBy(snowdrop, document.activeElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ModalHost: reopening the same dialog', () => {
  it('still closes it when its subject goes', async () => {
    const { snowdrop, group } = await host();
    await openModal(snowdrop, 'leaveGroup', { conversationId: group.id });
    await screen.findByRole('dialog');
    // The same dialog asked for again: another object, the same content.
    await openModal(snowdrop, 'leaveGroup', { conversationId: group.id });
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => {
      const { [group.id]: _gone, ...rest } = snowdrop.stores.conversations.getState().byId;
      snowdrop.stores.conversations.setState({ byId: rest });
    });
    await waitFor(() => {
      expect(snowdrop.stores.ui.getState().modal).toBeNull();
    });
  });
});
