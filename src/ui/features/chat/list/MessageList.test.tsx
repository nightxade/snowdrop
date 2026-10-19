import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { mergeDuplicate, messageId, type Message } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { conversationFocusTarget } from '@/ui/hooks';
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

describe('focus() vs focusLatest()', () => {
  /** A deterministic two-message window, rendered and settled, with the chat controller. */
  async function openTwoMessages(snowdrop: Snowdrop) {
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
    const author = conv.memberIds[0]!;
    const olderId = messageId(author, 3_000_000);
    const newerId = messageId(author, 3_000_060);
    const messages: Message[] = [olderId, newerId].map((id, i) => ({
      id,
      conversationId: conv.id,
      authorId: author,
      sentAt: 3_000_000 + i * 60_000,
      receivedAt: 3_000_000 + i * 60_000,
      body: `focus-latest message ${i}`,
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
    }));
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(conv.id);
      await snowdrop.history.open(conv.id);
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
    const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
    await waitFor(
      () => {
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
        });
        expect(document.querySelector(`[data-message-id="${olderId}"]`)).toBeTruthy();
        expect(document.querySelector(`[data-message-id="${newerId}"]`)).toBeTruthy();
      },
      { timeout: 3000 },
    );
    // Move the roving tab stop to the older message (e.g. a quote jump) and
    // off it again, the way leaving the composer would find it.
    await act(async () => {
      await chat.reveal(conv.id, olderId, { focus: true });
      await new Promise((r) => requestAnimationFrame(r));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(olderId);
    (document.activeElement as HTMLElement | null)?.blur();
    return { conv, chat, olderId, newerId };
  }

  it('focus() keeps using the last tab stop (e.g. the "Focus the message list" command)', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { chat, olderId } = await openTwoMessages(snowdrop);
    act(() => {
      chat.navigation?.focus();
    });
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(olderId);
  });

  it('focusLatest() always lands on the newest message and scrolls it into view', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { chat, newerId } = await openTwoMessages(snowdrop);
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    act(() => {
      chat.navigation?.focusLatest();
    });
    // focusLatest() awaits jumpToPresent (a resolved promise here, already
    // anchored) then two animation frames before focusing the row.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(document.activeElement?.getAttribute('data-message-id')).toBe(newerId);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));
  });
});

describe('prefetching older history', () => {
  it('requests the next page before the reader reaches the physical top, coalescing repeat triggers', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const { conv } = await withHistory(snowdrop, 300);
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

    const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
    // Virtuoso's mock only renders rows once its scroller sees a scroll event.
    await waitFor(
      () => {
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
        });
        expect(document.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    const loadOlder = vi.spyOn(snowdrop.history, 'loadOlder');
    // Holds the first page load open, so a second trigger lands while it's
    // still in flight — the race `page()`'s coalescing exists for.
    let resolveFirstPage!: (messages: Message[]) => void;
    const pending = new Promise<Message[]>((resolve) => {
      resolveFirstPage = resolve;
    });
    const pageSpy = vi.spyOn(snowdrop.repository, 'page').mockImplementationOnce(() => pending);

    // A few rows short of the literal top (not 0): only the rangeChanged-driven
    // prefetch — not startReached, which needs the physical boundary — can
    // explain a call from here.
    await act(async () => {
      scroller.scrollTop = 3 * 48;
      scroller.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); // let Virtuoso's mock engine process the scroll
    });
    expect(loadOlder).toHaveBeenCalledWith(conv.id);
    expect(pageSpy).toHaveBeenCalledTimes(1);

    // A second trigger while that load is still pending (a fast fling fires
    // several scroll events before a page lands) must not start another one.
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(pageSpy).toHaveBeenCalledTimes(1);

    resolveFirstPage([]);
    await settle(snowdrop);
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

describe('the list focus resolver', () => {
  it('never reports success (e.g. a stale <body>) when navigation.focus() fails to actually move focus', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
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

    // Something outside the list has focus (e.g. the sidebar row just
    // clicked) before the resolver runs.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    // Simulate the race the fix guards against: asking an element to focus
    // doesn't actually move focus (the scroller's tabIndex hasn't landed
    // yet, a WebKit quirk, or no row mounted at all). The resolver must
    // report that as a miss, not echo back whatever was focused before.
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => undefined);
    try {
      expect(conversationFocusTarget(conv.id)).toBeNull();
    } finally {
      focusSpy.mockRestore();
    }
    outside.remove();
  });

  it('reports the scroller itself as success once focus actually lands inside it', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Engineering',
    )!;
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

    const target = conversationFocusTarget(conv.id);
    expect(target).not.toBeNull();
    expect(document.querySelector('[data-message-scroller]')?.contains(target)).toBe(true);
  });
});
