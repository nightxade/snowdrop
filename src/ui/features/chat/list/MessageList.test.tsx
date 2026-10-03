import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
