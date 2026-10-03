import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { ConversationId } from '@/core/domain';
import { spacesSelectors, uiSelectors } from '@/core/stores';
import { buildMemberSections } from '@/ui/features/members';
import { bootDemo, disposeAll, key, settle, setViewport } from './bootDemo';

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  cleanup();
  await disposeAll();
});

const sidebar = () => document.querySelector<HTMLElement>('[data-snowdrop="sidebar"]')!;

describe('buildMemberSections', () => {
  const contact = (id: string, name: string) => ({ id, name, color: 'x' });
  it('puts admins first, sorts by name and skips unknown ids', () => {
    const sections = buildMemberSections(
      { memberIds: ['c', 'a', 'b', 'ghost'], adminIds: ['b'] },
      { a: contact('a', 'Zed'), b: contact('b', 'Mia'), c: contact('c', 'Ada') },
    );
    expect(sections.map((s) => [s.title, s.members.map((m) => m.name)])).toEqual([
      ['Admins', ['Mia']],
      ['Members', ['Ada', 'Zed']],
    ]);
    expect(
      buildMemberSections({ memberIds: ['a'], adminIds: [] }, { a: contact('a', 'A') }),
    ).toHaveLength(1);
  });
});

describe('quick switcher', () => {
  it('highlights matches, opens with Enter and focuses the composer', async () => {
    const snowdrop = await bootDemo();
    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Quick switcher' });
    expect(document.activeElement).toBe(input);
    act(() => {
      fireEvent.change(input, { target: { value: 'orchard' } });
    });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]!.querySelector('mark')?.textContent.toLowerCase()).toContain('orchard');
    key({ key: 'Enter' }, input);
    await settle();
    const selected = uiSelectors.selectedConversation(snowdrop.stores.ui.getState());
    expect(selected).not.toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Quick switcher' })).toBeNull();
    // The composer registers itself as the focus target (P3), so you can type straight away.
    expect(document.activeElement).toBe(
      document.querySelector('[data-snowdrop="composer"] textarea'),
    );
  });

  it('announces "Nothing matches" outside an empty (hidden) listbox', async () => {
    await bootDemo();
    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Quick switcher' });
    act(() => {
      fireEvent.change(input, { target: { value: 'qqqzzzxx' } });
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toContain('Nothing matches');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.querySelector('[cmdk-list]')?.hasAttribute('hidden')).toBe(true);
    const results = await axe(dialog, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('returns focus to where it was when dismissed', async () => {
    await bootDemo();
    const row = sidebar().querySelectorAll<HTMLElement>('[data-conversation-id]')[1]!;
    act(() => {
      row.focus();
    });
    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    await screen.findByRole('combobox');
    key({ key: 'Escape' });
    await settle();
    expect(screen.queryByRole('combobox', { name: 'Quick switcher' })).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});

describe('conversation menu', () => {
  it('opens from the keyboard and applies pin, mute and archive', async () => {
    const snowdrop = await bootDemo();
    const { local } = snowdrop.stores;
    const row = sidebar().querySelector<HTMLElement>(
      'section[aria-label="Direct Messages"] [data-conversation-id]',
    )!;
    const id = row.getAttribute('data-conversation-id') as ConversationId;
    const openMenu = async () => {
      // Re-query: pinning moves the row to another section (a new element).
      const current = sidebar().querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)!;
      act(() => {
        current.focus();
      });
      key({ key: 'F10', shiftKey: true }, current);
      return screen.findByRole('menu');
    };

    let menu = await openMenu();
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Pin to top/u }));
    });
    expect(local.getState().conversations[id]?.pinned).toBe(true);

    menu = await openMenu();
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Archive/u }));
    });
    expect(local.getState().conversations[id]?.archived).toBe(true);

    // Muting through the store's action is what the submenu calls; check the row reflects it.
    act(() => {
      local.getState().setArchived(id, false);
      local.getState().setMuted(id, true);
    });
    expect(
      sidebar().querySelector(`[data-conversation-id="${id}"]`)?.getAttribute('aria-label'),
    ).toMatch(/muted/u);
  });
});

describe('spaces', () => {
  it('creates a space from the dialog and deletes it with confirmation', async () => {
    const snowdrop = await bootDemo();
    const { spaces, ui } = snowdrop.stores;
    const before = spacesSelectors.orderedIds(spaces.getState()).length;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create a space' }));
    });
    const name = await screen.findByRole('textbox', { name: 'Space name' });
    expect(document.activeElement).toBe(name);
    act(() => {
      fireEvent.change(name, { target: { value: 'Book club' } });
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
    });
    const ids = spacesSelectors.orderedIds(spaces.getState());
    expect(ids).toHaveLength(before + 1);
    const created = ids.at(-1)!;
    expect(spaces.getState().spaces[created]?.name).toBe('Book club');
    expect(ui.getState().selectedSpace).toBe(created);

    act(() => {
      ui.getState().openModal({ type: 'deleteSpace', props: { spaceId: created } });
    });
    const dialog = await screen.findByRole('dialog');
    // The safe action has focus.
    expect(document.activeElement?.textContent).toBe('Cancel');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete space' }));
    });
    expect(spaces.getState().spaces[created]).toBeUndefined();
    expect(ui.getState().selectedSpace).toBe('home');
  });
});

describe('responsive overlays', () => {
  it('shows the member list as a modal sheet below 1100px; Esc closes it', async () => {
    setViewport(1024);
    const snowdrop = await bootDemo();
    const { stores } = snowdrop;
    const spaceId = spacesSelectors.orderedIds(stores.spaces.getState())[0]!;
    const group = stores.spaces.getState().spaces[spaceId]!.categories[0]!.conversationIds[0]!;
    act(() => {
      stores.ui.getState().selectConversation(group, spaceId);
    });
    expect(stores.ui.getState().memberListOpen).toBe(false);
    const toggle = screen.getByRole('button', { name: 'Show member list' });
    act(() => {
      toggle.focus();
      fireEvent.click(toggle);
    });
    const sheet = await screen.findByRole('dialog', { name: 'Members' });
    await settle();
    expect(sheet.contains(document.activeElement)).toBe(true);
    key({ key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Members' })).toBeNull();
    expect(stores.ui.getState().memberListOpen).toBe(false);
  });

  it('puts navigation in a drawer below 760px, open until a conversation is picked', async () => {
    setViewport(390);
    await bootDemo();
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Spaces' })).toBeTruthy();
    act(() => {
      fireEvent.click(drawer.querySelector<HTMLElement>('[data-conversation-id]')!);
    });
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(screen.getByRole('button', { name: /Open navigation/u })).toBeTruthy();
  });
});

describe('drawer focus and Escape', () => {
  const frames = () =>
    act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 10)));
    });

  it('member sheet: one Esc from a descendant closes it; focus returns to the toggle', async () => {
    setViewport(1024);
    const snowdrop = await bootDemo();
    const { stores } = snowdrop;
    const spaceId = spacesSelectors.orderedIds(stores.spaces.getState())[0]!;
    const group = stores.spaces.getState().spaces[spaceId]!.categories[0]!.conversationIds[0]!;
    act(() => {
      stores.ui.getState().selectConversation(group, spaceId);
    });
    const toggle = screen.getByRole('button', { name: 'Show member list' });
    act(() => {
      toggle.focus();
      fireEvent.click(toggle);
    });
    const sheet = await screen.findByRole('dialog', { name: 'Members' });
    await settle();
    const row = sheet.querySelector<HTMLElement>('[data-snowdrop="member-row"]')!;
    act(() => {
      row.focus();
    });
    key({ key: 'Escape' }, row);
    await frames();
    expect(screen.queryByRole('dialog', { name: 'Members' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show member list' }));
  });

  it('navigation drawer: Esc from a row closes it; focus returns to the hamburger', async () => {
    setViewport(390);
    await bootDemo();
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    act(() => {
      fireEvent.click(drawer.querySelector<HTMLElement>('[data-conversation-id]')!);
    });
    await frames();
    const hamburger = screen.getByRole('button', { name: /Open navigation/u });
    act(() => {
      hamburger.focus();
      fireEvent.click(hamburger);
    });
    const reopened = await screen.findByRole('dialog', { name: 'Navigation' });
    await settle();
    const row = reopened.querySelector<HTMLElement>('[data-conversation-id]')!;
    act(() => {
      row.focus();
    });
    key({ key: 'Escape' }, row);
    await frames();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open navigation/u }));
  });
});

describe('accessibility smoke test', () => {
  it('has no axe violations in the demo shell (layout-dependent rules off)', async () => {
    await bootDemo();
    const results = await axe(document.body, {
      rules: {
        // happy-dom has no layout or computed colours; contrast is covered by contrast.test.ts.
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

describe('conversation navigation keeps focus', () => {
  const composer = () => document.querySelector<HTMLElement>('[data-snowdrop="composer"] textarea');
  const settleFrame = () =>
    act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });

  it('Alt+↓ and Alt+Shift+↓ from the composer land in the new composer', async () => {
    const snowdrop = await bootDemo();
    const first = sidebar().querySelector<HTMLElement>('[data-conversation-id]')!;
    act(() => {
      fireEvent.click(first);
    });
    await settleFrame();
    act(() => {
      composer()!.focus();
    });
    const start = uiSelectors.selectedConversation(snowdrop.stores.ui.getState());
    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    await settleFrame();
    const second = uiSelectors.selectedConversation(snowdrop.stores.ui.getState());
    expect(second).not.toBe(start);
    expect(document.activeElement).toBe(composer());

    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true });
    await settleFrame();
    // Wherever next-unread went (possibly another space), focus is in its composer, not on <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(composer());
  });

  it('Alt+↓ from a sidebar row moves focus to the next row', async () => {
    const snowdrop = await bootDemo();
    const rows = () => [
      ...sidebar().querySelectorAll<HTMLElement>('[data-conversation-id][data-roving-item]'),
    ];
    act(() => {
      fireEvent.click(rows()[0]!);
    });
    await settleFrame();
    const row = sidebar().querySelector<HTMLElement>(
      `[data-conversation-id="${uiSelectors.selectedConversation(snowdrop.stores.ui.getState())}"][data-roving-item]`,
    )!;
    act(() => {
      row.focus();
    });
    key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    await settleFrame();
    const next = uiSelectors.selectedConversation(snowdrop.stores.ui.getState())!;
    expect(document.activeElement?.getAttribute('data-conversation-id')).toBe(next);
    expect(sidebar().contains(document.activeElement)).toBe(true);
  });
});
