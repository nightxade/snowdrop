/**
 * While the backend is "catching up" (CatchUpTracker; stores.session.catchingUp),
 * the sidebar must not visibly cycle through old previews: every preview shows
 * "Loading…", and the rendered order and unread badges hold at their pre-catch-up
 * values — except a brand-new conversation, which still surfaces. Once catching
 * up ends, everything updates to the live state at once.
 */
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import type { Snowdrop } from '@/app/createSnowdrop';
import { directConversationId, type ConversationId } from '@/core/domain';
import { makeConversation, makeMessage } from '@/core/domain/testing';
import { ConversationList } from './ConversationList';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('ConversationList: catching up', () => {
  it('freezes order, badges and previews while catching up, then updates at once', async () => {
    snowdrop = await bootSnowdrop();
    const stores = snowdrop.stores;
    const selfId = stores.session.getState().self?.id;
    if (!selfId) throw new Error('no self id after boot');

    const ana = directConversationId('ana');
    const bo = directConversationId('bo');
    const cass = directConversationId('cass');
    const known = new Set<ConversationId>([ana, bo, cass]);
    // Ordinary chats: a message request would show "Message request" instead of its preview.
    for (const id of known) stores.local.getState().markAccepted(id, 0);

    act(() => {
      stores.conversations.getState().upsertMany([
        makeConversation({
          id: ana,
          kind: 'direct',
          title: 'Ana',
          memberIds: [selfId, 'ana'],
          lastActivityAt: 1000,
        }),
        makeConversation({
          id: bo,
          kind: 'direct',
          title: 'Bo',
          memberIds: [selfId, 'bo'],
          lastActivityAt: 2000,
        }),
      ]);
      stores.conversations
        .getState()
        .noteLatest(
          makeMessage({ conversationId: bo, authorId: 'bo', sentAt: 2000, body: 'see you then' }),
        );
    });
    await settle(snowdrop);
    renderWithSnowdrop(snowdrop, <ConversationList />);

    const rows = () =>
      screen
        .getAllByRole('button')
        .filter((r) => known.has(r.getAttribute('data-conversation-id') as ConversationId));
    const order = () => rows().map((r) => r.getAttribute('data-conversation-id'));
    const rowFor = (id: ConversationId) => {
      const row = rows().find((r) => r.getAttribute('data-conversation-id') === id);
      const li = row?.closest('li');
      if (!li) throw new Error(`no row for ${id}`);
      return li;
    };
    const nav = () => screen.getByRole('navigation');

    // Bo is the more recent conversation, so it sorts first; its real preview shows.
    expect(order()).toEqual([bo, ana]);
    expect(within(rowFor(bo)).getByText('see you then')).toBeTruthy();
    expect(nav().getAttribute('aria-busy')).toBe('false');

    act(() => {
      stores.session.getState().setCatchingUp(true);
    });
    await settle(snowdrop);
    expect(nav().getAttribute('aria-busy')).toBe('true');
    expect(within(rowFor(bo)).getByText('Loading…')).toBeTruthy();
    expect(within(rowFor(ana)).getByText('Loading…')).toBeTruthy();

    act(() => {
      // An "old" message resurfacing for Ana during the drain: in real life this
      // would bump it to the top and give it an unread badge. Both must wait.
      stores.conversations.getState().bumpActivity(ana, 9000);
      stores.conversations.getState().setUnread(ana, { count: 2, mentions: 2 });
      stores.conversations
        .getState()
        .noteLatest(
          makeMessage({ conversationId: ana, authorId: 'ana', sentAt: 9000, body: 'old news' }),
        );
      // A brand-new conversation can still appear mid catch-up.
      stores.conversations.getState().upsertMany([
        makeConversation({
          id: cass,
          kind: 'direct',
          title: 'Cass',
          memberIds: [selfId, 'cass'],
          lastActivityAt: 9500,
        }),
      ]);
    });
    await settle(snowdrop);

    // Order unchanged for the two known conversations; the new one surfaces ahead of them.
    expect(order()).toEqual([cass, bo, ana]);
    // Ana's preview still reads "Loading…", not the message that just arrived.
    expect(within(rowFor(ana)).getByText('Loading…')).toBeTruthy();
    expect(within(rowFor(ana)).queryByText('old news')).toBeNull();
    // Ana's badge is still frozen at zero: no unread marker.
    expect(rowFor(ana).getAttribute('data-unread')).toBeNull();

    act(() => {
      stores.session.getState().setCatchingUp(false);
    });
    await settle(snowdrop);

    // Everything updates at once, in live recency order, with real previews and badges.
    expect(order()).toEqual([cass, ana, bo]);
    expect(within(rowFor(ana)).getByText('old news')).toBeTruthy();
    expect(within(rowFor(bo)).getByText('see you then')).toBeTruthy();
    expect(nav().getAttribute('aria-busy')).toBe('false');
    expect(rowFor(ana).getAttribute('data-unread')).toBe('');
  });
});
