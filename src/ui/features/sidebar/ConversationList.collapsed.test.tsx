/**
 * A collapsed section keeps visible exactly what the rows' own dots and
 * badges say needs attention, holds still while catching up, and is the order
 * Alt+↑/↓ walks.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import type { Snowdrop } from '@/app/createSnowdrop';
import { directConversationId, type ConversationId } from '@/core/domain';
import { makeConversation } from '@/core/domain/testing';
import { ConversationList } from './ConversationList';
import { currentNavigationOrder } from './useSidebarModel';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

const names = ['ana', 'bo', 'cass', 'dee', 'eli'] as const;
type Name = (typeof names)[number];
const idOf = (name: Name) => directConversationId(name);

/** A Home list of five known chats, with every other chat of the demo set aside, and its one section collapsed. */
async function boot() {
  snowdrop = await bootSnowdrop();
  const { stores } = snowdrop;
  const selfId = stores.session.getState().self!.id;
  act(() => {
    for (const id of Object.keys(stores.conversations.getState().byId)) {
      stores.local.getState().setArchived(id as ConversationId, true);
    }
    stores.conversations.getState().upsertMany(
      names.map((name, i) =>
        makeConversation({
          id: idOf(name),
          kind: 'direct',
          title: name,
          memberIds: [selfId, name],
          lastActivityAt: 10_000 - i,
        }),
      ),
    );
    for (const name of names) stores.local.getState().markAccepted(idOf(name), 0);
    stores.spaces.getState().toggleHomeSection('conversations');
  });
  await settle(snowdrop);
  renderWithSnowdrop(snowdrop, <ConversationList />);
  const shown = (): Name[] =>
    names.filter((name) => document.querySelector(`[data-conversation-id="${idOf(name)}"]`));
  return { snowdrop, stores, shown };
}

describe('Collapsed section: what stays visible', () => {
  it('follows the row: muted unread hides, marked unread and muted mentions show', async () => {
    const { stores, shown } = await boot();
    expect(shown()).toEqual([]);
    act(() => {
      // Muted, with unread messages and no mention: the row has no dot, so it stays tucked away.
      stores.local.getState().setMuted(idOf('ana'), true);
      stores.conversations.getState().setUnread(idOf('ana'), { count: 3, mentions: 0 });
      // Marked unread by hand: the row's dot shows, so the row does.
      stores.local.getState().setMarkedUnread(idOf('bo'), true);
      // Ordinary unread.
      stores.conversations.getState().setUnread(idOf('cass'), { count: 1, mentions: 0 });
      // Muted, but it mentions you: the row's mention badge shows.
      stores.local.getState().setMuted(idOf('dee'), true);
      stores.conversations.getState().setUnread(idOf('dee'), { count: 2, mentions: 1 });
    });
    await settle(snowdrop!);
    expect(shown()).toEqual(['bo', 'cass', 'dee']);
    // Each visible row has an indicator of its own, and the hidden one has none.
    const row = (name: Name) =>
      document.querySelector(`[data-conversation-id="${idOf(name)}"]`)?.closest('li');
    expect(row('bo')?.getAttribute('data-unread')).toBe('');
    expect(row('cass')?.getAttribute('data-unread')).toBe('');
    expect(row('dee')?.textContent).toMatch(/1/u);
  });

  it('holds still while catching up, then follows the live state', async () => {
    const { stores, shown } = await boot();
    act(() => {
      stores.conversations.getState().setUnread(idOf('cass'), { count: 1, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(shown()).toEqual(['cass']);

    act(() => {
      stores.session.getState().setCatchingUp(true);
    });
    await settle(snowdrop!);
    act(() => {
      // Old messages draining: one chat gains unread, another is read.
      stores.conversations.getState().setUnread(idOf('eli'), { count: 4, mentions: 0 });
      stores.conversations.getState().setUnread(idOf('cass'), { count: 0, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(shown()).toEqual(['cass']);
    expect(currentNavigationOrder(stores)).toEqual([idOf('cass')]);

    act(() => {
      stores.session.getState().setCatchingUp(false);
    });
    await settle(snowdrop!);
    expect(shown()).toEqual(['eli']);
    expect(currentNavigationOrder(stores)).toEqual([idOf('eli')]);
  });

  it('keyboard stepping walks the rendered rows, and falls back to the same rule when no list is mounted', async () => {
    const { stores } = await boot();
    act(() => {
      stores.conversations.getState().setUnread(idOf('cass'), { count: 1, mentions: 0 });
      stores.local.getState().setMarkedUnread(idOf('bo'), true);
      stores.local.getState().setMuted(idOf('ana'), true);
      stores.conversations.getState().setUnread(idOf('ana'), { count: 5, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(currentNavigationOrder(stores)).toEqual([idOf('bo'), idOf('cass')]);
    cleanup();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(currentNavigationOrder(stores)).toEqual([idOf('bo'), idOf('cass')]);
  });
});
