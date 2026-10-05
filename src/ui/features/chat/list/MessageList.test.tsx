import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { mergeDuplicate, messageId, type Message } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessagePane } from '../MessagePane';
import * as act_ from '../message/actions';
import { Reactions, reactorsLabel } from '../message/Reactions';
import { TooltipProvider } from '@/ui/primitives';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

/** Backfills `count` old messages so the newest page doesn't contain the oldest ones. */
async function withHistory(snowdrop: Snowdrop, count: number) {
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  const author = conv.memberIds[0]!;
  const messages: Message[] = Array.from({ length: count }, (_, i) => ({
    id: messageId(author, 1_000_000 + i * 60_000),
    conversationId: conv.id,
    authorId: author,
    sentAt: 1_000_000 + i * 60_000,
    receivedAt: 1_000_000 + i * 60_000,
    body: `old message ${i}`,
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  }));
  await snowdrop.repository.upsertMany(messages, { backfill: true, merge: mergeDuplicate });
  return { conv, oldest: messages[0]! };
}

describe('jump to message', () => {
  it('loads history around an old message and detaches from the present', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { conv, oldest } = await withHistory(snowdrop, 300);
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
    });
    const chat = new ChatController();
    renderWithSnowdrop(
      snowdrop,
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
        <ChatControllerProvider value={chat}>
          <MessagePane conversationId={conv.id} />
        </ChatControllerProvider>
      </VirtuosoMockContext.Provider>,
    );
    await settle(snowdrop);
    const inWindow = () =>
      oldest.id in messagesSelectors.window(conv.id)(snowdrop.stores.messages.getState()).byId;
    expect(inWindow()).toBe(false);

    const jumpTo = vi.spyOn(snowdrop.history, 'jumpTo');
    await act(async () => {
      await chat.reveal(conv.id, oldest.id);
    });
    await settle(snowdrop);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(jumpTo).toHaveBeenCalledWith(conv.id, oldest.id);
    expect(inWindow()).toBe(true);
    // (happy-dom has no layout, so Virtuoso renders no rows at an initial index;
    // the scroll + flash itself is covered by the Playwright pass.)
    // Detached from the present: the jump pill offers the way back.
    expect(document.querySelector('[data-snowdrop="jump-to-present"]')).not.toBeNull();
  });

  it('a second quick "jump to" with focus cancels the first pending focus instead of landing on it', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
    const author = conv.memberIds[0]!;
    const firstId = messageId(author, 2_000_000);
    const secondId = messageId(author, 2_000_060);
    // A deterministic, two-message window set directly (bypassing
    // history.open's seeded demo content and its own timing): Virtuoso's
    // happy-dom row rendering below can't be aimed at a particular spot in a
    // real conversation's history, so keeping the window this small means
    // whatever it renders includes both.
    const messages: Message[] = [firstId, secondId].map((id, i) => ({
      id,
      conversationId: conv.id,
      authorId: author,
      sentAt: 2_000_000 + i * 60_000,
      receivedAt: 2_000_000 + i * 60_000,
      body: `focus race message ${i}`,
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
    }));
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
      // Overwrite with a small, deterministic window: history.open's own
      // bookkeeping (unread marker, etc.) stays, but the row content below
      // no longer depends on the demo's seeded/time-of-day content.
      snowdrop.stores.messages
        .getState()
        .replaceWindow(conv.id, messages, { hasMoreBefore: false, hasMoreAfter: false });
    });
    const chat = new ChatController();
    renderWithSnowdrop(
      snowdrop,
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
        <ChatControllerProvider value={chat}>
          <MessagePane conversationId={conv.id} />
        </ChatControllerProvider>
      </VirtuosoMockContext.Provider>,
    );
    await settle(snowdrop);

    // Virtuoso only renders rows in happy-dom once its scroller sees a scroll
    // event, and even then not reliably on the very next tick — so this
    // keeps re-dispatching it until the rows actually show up.
    const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
    await waitFor(
      () => {
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
        });
        expect(document.querySelector(`[data-message-id="${firstId}"]`)).toBeTruthy();
        expect(document.querySelector(`[data-message-id="${secondId}"]`)).toBeTruthy();
      },
      { timeout: 3000 },
    );

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

    await act(async () => {
      await chat.reveal(conv.id, firstId, { focus: true });
      await new Promise((r) => requestAnimationFrame(r));
    });
    // Before the first jump's 350ms focus timer fires, a second jump supersedes it.
    await act(async () => {
      await chat.reveal(conv.id, secondId, { focus: true });
      await new Promise((r) => requestAnimationFrame(r));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Only the superseding jump's focus actually fires: the first one was
    // cancelled, rather than landing on a stale row after the fact.
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(secondId);
  });

  it('says so when the quoted message is not stored locally', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { conv } = await withHistory(snowdrop, 1);
    const chat = new ChatController();
    renderWithSnowdrop(
      snowdrop,
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 48 }}>
        <ChatControllerProvider value={chat}>
          <MessagePane conversationId={conv.id} />
        </ChatControllerProvider>
      </VirtuosoMockContext.Provider>,
    );
    await settle(snowdrop);
    let ok = true;
    await act(async () => {
      ok = await chat.reveal(conv.id, messageId('nobody', 42));
    });
    expect(ok).toBe(false);
    expect(snowdrop.stores.ui.getState().toasts.at(-1)?.message).toMatch(/isn't available/u);
  });
});

describe('reactions', () => {
  it('labels who reacted, you first', () => {
    const names: Record<string, string> = { a: 'Ada', b: 'Bo', c: 'Cy', d: 'Di' };
    const nameFor = (id: string) => names[id] ?? '?';
    expect(reactorsLabel(['a'], 'me', nameFor)).toBe('Ada');
    expect(reactorsLabel(['a', 'me'], 'me', nameFor)).toBe('You and Ada');
    expect(reactorsLabel(['a', 'b', 'c'], null, nameFor)).toBe('Ada, Bo and Cy');
    expect(reactorsLabel(['a', 'b', 'c', 'd'], null, nameFor)).toBe('Ada, Bo and 2 others');
  });

  it('outlines own reactions and toggles on click', () => {
    const onToggle = vi.fn();
    render(
      <TooltipProvider>
        <Reactions
          reactions={[
            { emoji: '🎯', authorId: 'me', at: 1 },
            { emoji: '🎯', authorId: 'a', at: 2 },
            { emoji: '👀', authorId: 'a', at: 3 },
          ]}
          selfId="me"
          nameFor={(id) => id}
          onToggle={onToggle}
          onAdd={vi.fn()}
        />
      </TooltipProvider>,
    );
    const target = screen.getByRole('button', { name: /^🎯 2/u });
    const eyes = screen.getByRole('button', { name: /^👀 1/u });
    expect(target.getAttribute('aria-pressed')).toBe('true');
    expect(target.hasAttribute('data-mine')).toBe(true);
    expect(eyes.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(eyes);
    expect(onToggle).toHaveBeenCalledWith('👀');
  });

  it('adds and removes our reaction optimistically, tracking usage', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!;
    await act(async () => {
      await snowdrop.history.open(conv.id);
    });
    const app = snowdrop;
    const target = messagesSelectors
      .list(conv.id)(snowdrop.stores.messages.getState())
      .findLast((m) => m.kind === 'normal' && !m.deleted)!;
    const selfId = snowdrop.stores.session.getState().self!.id;
    const current = () =>
      messagesSelectors.message(conv.id, target.id)(snowdrop.stores.messages.getState())!;
    act(() => {
      act_.toggleReaction(app, current(), '🦊');
    });
    expect(current().reactions.some((r) => r.authorId === selfId && r.emoji === '🦊')).toBe(true);
    expect(snowdrop.stores.local.getState().reactionUsage['🦊']).toBe(1);
    await settle(snowdrop);
    act(() => {
      act_.toggleReaction(app, current(), '🦊');
    });
    await settle(snowdrop);
    expect(current().reactions.some((r) => r.authorId === selfId && r.emoji === '🦊')).toBe(false);
  });
});
