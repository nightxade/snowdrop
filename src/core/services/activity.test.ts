import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import type { BackendEvents } from '@/core/backend';
import {
  directConversationId,
  mergeDuplicate,
  messageId,
  type ConversationId,
  type Message,
  type PollContent,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { NotificationService, type NotificationApi } from './NotificationService';
import { PENDING_OPS_TTL_MS } from './PendingOpsBuffer';
import { SendService } from './SendService';
import { SyncService, type SyncEvents } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const HOUR = 3_600_000;

const message = (
  conversationId: ConversationId,
  authorId: string,
  sentAt: number,
  extra: Partial<Message> = {},
): Message => ({
  id: messageId(authorId, sentAt),
  conversationId,
  authorId,
  sentAt,
  receivedAt: NOW,
  body: `message ${sentAt - NOW}`,
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
  ...extra,
});

async function setup(options: { readSync?: boolean } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.capabilities.setFeature('readSync', options.readSync ?? true);
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    onError,
  });
  await sync.start();
  await sync.idle();
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    onError,
    onExpiry: (at) => {
      sync.noteExpiry(at);
    },
  });
  const conv = backend.world.conversationIds.get('crux')!;
  const selfId = backend.world.self.id;
  const peerOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const markRead = vi.spyOn(backend, 'markRead');
  // Everything stored so far is read; the tests start from a clean slate.
  await sync.markConversationRead(conv);
  markRead.mockClear();
  backend.readReceiptsSent.length = 0;
  const view = () => {
    stores.ui.getState().setWindowFocused(true);
    stores.ui.getState().selectConversation(conv);
  };
  const away = () => {
    stores.ui.getState().setWindowFocused(false);
  };
  /** A message of the user's own, stored as if sent from another device. */
  const ownMessage = async (sentAt: number, extra: Partial<Message> = {}) => {
    backend.deliver(message(conv, selfId, sentAt, { status: 'sent', ...extra }));
    await sync.idle();
    return messageId(selfId, sentAt);
  };
  const react = (
    target: number,
    authorId: string,
    emoji: string,
    remove = false,
    targetAuthorId = selfId,
  ) => {
    backend.emit('reaction', {
      conversationId: conv,
      targetAuthorId,
      targetSentAt: target,
      reaction: { emoji, authorId, at: NOW + 50 },
      remove,
    });
  };
  const events = <E extends keyof SyncEvents>(event: E) => {
    const seen: SyncEvents[E][] = [];
    sync.on(event, (payload) => seen.push(payload));
    return seen;
  };
  return {
    backend,
    scheduler,
    repository,
    stores,
    sync,
    send,
    onError,
    conv,
    selfId,
    peerOf,
    markRead,
    view,
    away,
    ownMessage,
    react,
    events,
  };
}

describe('unread reactions on the user’s own messages', () => {
  it('reads a reaction at once while the chat is on screen, and syncs it as a read of the target', async () => {
    const { stores, sync, conv, selfId, peerOf, markRead, view, ownMessage, react } = await setup();
    await ownMessage(NOW + 1);
    view();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    expect(markRead).toHaveBeenCalledTimes(1);
    // Author is the user, timestamp is the target's, and only the user's own devices are told.
    expect(markRead).toHaveBeenCalledWith(conv, [{ authorId: selfId, sentAt: NOW + 1 }], {
      syncOnly: true,
    });
  });

  it('keeps it unread while the user is away, off the badge, then reads and syncs it when the chat is read', async () => {
    const { stores, sync, conv, selfId, peerOf, markRead, away, ownMessage, react } = await setup();
    await ownMessage(NOW + 1);
    await ownMessage(NOW + 2);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 2, peerOf(conv), '❤️');
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1, NOW + 2]);
    expect(stores.conversations.getState().unread[conv]?.count ?? 0).toBe(0);
    expect(markRead).not.toHaveBeenCalled();
    await sync.markConversationRead(conv);
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith(
      conv,
      [
        { authorId: selfId, sentAt: NOW + 1 },
        { authorId: selfId, sentAt: NOW + 2 },
      ],
      { syncOnly: true },
    );
  });

  it('sends the reaction sync next to the receipts for unread messages, never as a receipt', async () => {
    const { backend, sync, conv, selfId, peerOf, markRead, away, ownMessage, react } =
      await setup();
    await ownMessage(NOW + 1);
    away();
    backend.deliver(message(conv, peerOf(conv), NOW + 2));
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(2);
    const calls = markRead.mock.calls.map(([, refs, options]) => ({ refs, options }));
    expect(calls).toContainEqual({
      refs: [{ authorId: peerOf(conv), sentAt: NOW + 2 }],
      options: undefined,
    });
    expect(calls).toContainEqual({
      refs: [{ authorId: selfId, sentAt: NOW + 1 }],
      options: { syncOnly: true },
    });
  });

  it('only counts someone else’s reaction to the user’s own message, once per emoji', async () => {
    const { stores, sync, conv, selfId, peerOf, away, ownMessage, react, events } = await setup();
    await ownMessage(NOW + 1);
    away();
    const seen = events('reactionActivity');
    react(NOW + 1, selfId, '👍'); // the user's own reaction (another device)
    react(NOW + 99, peerOf(conv), '👍'); // a message that is not stored
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 1, peerOf(conv), '👍'); // a re-delivery
    await sync.idle();
    expect(seen.map((e) => e.kind)).toEqual(['react']);
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
  });

  it('does not treat a reaction to someone else’s message as news', async () => {
    const { backend, stores, sync, conv, peerOf, away, react, events } = await setup();
    const theirs = message(conv, peerOf(conv), NOW + 3);
    backend.deliver(theirs);
    await sync.idle();
    await sync.markConversationRead(conv);
    away();
    const seen = events('reactionActivity');
    react(NOW + 3, peerOf(conv), '👍', false, peerOf(conv));
    await sync.idle();
    expect(seen).toEqual([]);
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
  });

  it('announces a reaction replaced or taken back, with the target as it stands', async () => {
    const { sync, conv, peerOf, away, ownMessage, react, events } = await setup();
    await ownMessage(NOW + 1);
    away();
    const seen = events('reactionActivity');
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 1, peerOf(conv), '❤️');
    react(NOW + 1, peerOf(conv), '👍', true); // taking back what was already replaced: nothing
    react(NOW + 1, peerOf(conv), '❤️', true);
    await sync.idle();
    expect(seen.map((e) => [e.kind, e.emoji])).toEqual([
      ['react', '👍'],
      ['react', '❤️'],
      ['unreact', '❤️'],
    ]);
    expect(seen[0]?.message.id).toBe(messageId(seen[0]!.message.authorId, NOW + 1));
    expect(seen[0]?.message.reactions.map((r) => r.emoji)).toEqual(['👍']);
  });

  it('marks the reaction live or parked like the messages around it', async () => {
    const { sync, conv, peerOf, away, ownMessage, react, events } = await setup();
    await ownMessage(NOW + 1);
    away();
    const seen = events('reactionActivity');
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(seen[0]?.live).toBe(true);
  });

  it('sends nothing to an old signal-cli, which would turn a sync into a real receipt', async () => {
    const { stores, sync, conv, peerOf, markRead, view, ownMessage, react, backend } = await setup({
      readSync: false,
    });
    await ownMessage(NOW + 1);
    view();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    expect(markRead).not.toHaveBeenCalled();
    expect(backend.readReceiptsSent).toEqual([]);
  });

  it('clears an unread reaction when the phone reads it, without moving the read position', async () => {
    const { backend, stores, sync, conv, selfId, peerOf, away, ownMessage, react } = await setup();
    await ownMessage(NOW + 1);
    away();
    backend.deliver(message(conv, peerOf(conv), NOW + 2));
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    const unread = stores.conversations.getState().unread[conv]?.count;
    expect(unread).toBe(1);
    // The user's own message normally sits behind the read position already; put the
    // position behind it to see that this read of its reactions never moves it.
    stores.conversations.getState().setReadCursors({ [conv]: 0 });
    const cursor = stores.conversations.getState().readCursors[conv];
    backend.emit('readSync', { messages: [{ authorId: selfId, sentAt: NOW + 1 }] });
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    // The message after it is still unread: a read of a reaction says nothing about it.
    expect(stores.conversations.getState().readCursors[conv]).toBe(cursor);
  });

  it('forgets the unread reactions of a message that was deleted for everyone', async () => {
    const { backend, stores, sync, conv, selfId, peerOf, away, ownMessage, react, events } =
      await setup();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    const removed = events('messageRemoved');
    backend.emit('messageDeleted', {
      conversationId: conv,
      authorId: selfId,
      targetSentAt: NOW + 1,
    });
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    expect(removed.map((e) => e.message.id)).toEqual([messageId(selfId, NOW + 1)]);
  });
});

describe('unread poll votes on the user’s own polls', () => {
  const poll: PollContent = {
    question: 'Where to eat?',
    options: ['Pizza', 'Ramen'],
    allowMultiple: false,
    votes: [],
  };
  const vote = (
    conv: ConversationId,
    selfId: string,
    voterId: string,
    options: number[],
  ): BackendEvents['pollVote'] => ({
    conversationId: conv,
    targetAuthorId: selfId,
    targetSentAt: NOW + 1,
    voterId,
    optionIndexes: options,
    voteCount: 1,
    at: NOW + 60,
  });

  it('reads a vote at once on screen, and syncs it as a read of the poll', async () => {
    const { backend, stores, sync, conv, selfId, peerOf, markRead, view, ownMessage } =
      await setup();
    await ownMessage(NOW + 1, { poll });
    view();
    backend.emit('pollVote', vote(conv, selfId, peerOf(conv), [0]));
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    expect(markRead).toHaveBeenCalledWith(conv, [{ authorId: selfId, sentAt: NOW + 1 }], {
      syncOnly: true,
    });
  });

  it('keeps a vote unread while away, and never counts it as a message', async () => {
    const { backend, stores, sync, conv, selfId, peerOf, markRead, away, ownMessage } =
      await setup();
    await ownMessage(NOW + 1, { poll });
    away();
    backend.emit('pollVote', vote(conv, selfId, peerOf(conv), [1]));
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
    expect(stores.conversations.getState().unread[conv]?.count ?? 0).toBe(0);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('ignores a retracted vote, and the user’s own vote from another device', async () => {
    const { backend, stores, sync, conv, selfId, peerOf, away, ownMessage } = await setup();
    await ownMessage(NOW + 1, { poll });
    away();
    backend.emit('pollVote', vote(conv, selfId, peerOf(conv), []));
    backend.emit('pollVote', vote(conv, selfId, selfId, [0]));
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
  });
});

describe('disappearing messages start counting down when they are read', () => {
  const timed = (conv: ConversationId, author: string, sentAt: number) =>
    message(conv, author, sentAt, { expiresAfterReadMs: HOUR });

  it('keeps an unread message however long it sits, and expires it an hour after it is read', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, away } = await setup();
    away();
    const m = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(m);
    await sync.idle();
    // Hours later nothing has been lost: the countdown has not started.
    scheduler.advance(5 * HOUR);
    await sync.idle();
    expect(await repository.get(m.id)).toMatchObject({ expiresAfterReadMs: HOUR });
    expect(await repository.get(m.id)).not.toHaveProperty('expiresAt');
    const readAt = scheduler.now();
    await sync.markConversationRead(conv);
    const started = await repository.get(m.id);
    expect(started?.expiresAt).toBe(readAt + HOUR);
    expect(started).not.toHaveProperty('expiresAfterReadMs');
    scheduler.advance(HOUR - 1);
    await sync.idle();
    expect(await repository.get(m.id)).toBeDefined();
    scheduler.advance(31_000);
    await sync.idle();
    expect(await repository.get(m.id)).toBeUndefined();
  });

  it('starts the countdown on arrival when the user is looking at the chat', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, view } = await setup();
    view();
    const m = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(m);
    await sync.idle();
    expect((await repository.get(m.id))?.expiresAt).toBe(scheduler.now() + HOUR);
  });

  it('starts it when the phone reads the message', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, away } = await setup();
    away();
    const first = timed(conv, peerOf(conv), NOW + 1);
    const second = timed(conv, peerOf(conv), NOW + 2);
    const later = timed(conv, peerOf(conv), NOW + 3);
    for (const m of [first, second, later]) backend.deliver(m);
    await sync.idle();
    backend.emit('readSync', { messages: [{ authorId: peerOf(conv), sentAt: NOW + 2 }] });
    await sync.idle();
    expect((await repository.get(first.id))?.expiresAt).toBe(scheduler.now() + HOUR);
    expect((await repository.get(second.id))?.expiresAt).toBe(scheduler.now() + HOUR);
    // Past the phone's read position: still waiting.
    expect(await repository.get(later.id)).not.toHaveProperty('expiresAt');
  });

  it('starts it for what came before a message the user sent from another device', async () => {
    const { repository, scheduler, sync, conv, peerOf, away, ownMessage, backend } = await setup();
    away();
    const waiting = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(waiting);
    await sync.idle();
    expect(await repository.get(waiting.id)).not.toHaveProperty('expiresAt');
    // Replying from the phone means everything before it was read.
    await ownMessage(NOW + 2);
    expect((await repository.get(waiting.id))?.expiresAt).toBe(scheduler.now() + HOUR);
  });

  it('does not touch a message without a timer', async () => {
    const { backend, repository, sync, conv, peerOf, away } = await setup();
    away();
    const plain = message(conv, peerOf(conv), NOW + 1);
    backend.deliver(plain);
    await sync.idle();
    await sync.markConversationRead(conv);
    expect(await repository.get(plain.id)).not.toHaveProperty('expiresAt');
  });

  it('purges on schedule long after the connection finished starting', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, view } = await setup();
    view();
    const m = message(conv, peerOf(conv), NOW + 1, { expiresAt: NOW + 60_000 });
    backend.deliver(m);
    await sync.idle();
    // The first purge pass runs, then the message comes due.
    scheduler.advance(1_000);
    await sync.idle();
    scheduler.advance(60_000);
    await sync.idle();
    expect(await repository.get(m.id)).toBeUndefined();
  });

  it('runs a message the user sends in a chat with a timer from the send', async () => {
    const { scheduler, repository, stores, sync, send, conv } = await setup();
    const current = stores.conversations.getState().byId[conv]!;
    stores.conversations.getState().upsert({ ...current, expireTimerSec: 30 });
    await send.send({ conversationId: conv, text: 'quick', mentionIds: [], attachments: [] });
    const sent = (await repository.listAfter(conv, 0)).find((m) => m.body === 'quick')!;
    expect(sent.expiresAt).toBe(sent.sentAt + 30_000);
    scheduler.advance(30_000);
    await sync.idle();
    expect(await repository.get(sent.id)).toBeUndefined();
  });

  it('leaves an own message in a chat without a timer permanent', async () => {
    const { repository, send, conv } = await setup();
    await send.send({ conversationId: conv, text: 'stays', mentionIds: [], attachments: [] });
    const sent = (await repository.listAfter(conv, 0)).find((m) => m.body === 'stays')!;
    expect(sent).not.toHaveProperty('expiresAt');
  });
});

describe('a stranger’s system line and a deleted message request', () => {
  it('does not bring the deleted request back, but a real message does', async () => {
    const { backend, stores, sync } = await setup();
    const stranger = directConversationId('stranger-aci');
    stores.local.getState().markDeleted(stranger, NOW);
    backend.deliver(
      message(stranger, 'stranger-aci', NOW + 1, {
        kind: 'system',
        systemText: 'Safety Number with a stranger has changed',
      }),
    );
    await sync.idle();
    expect(stores.local.getState().deletedChats[stranger]).toBe(NOW);
    backend.deliver(message(stranger, 'stranger-aci', NOW + 2));
    await sync.idle();
    expect(stores.local.getState().deletedChats[stranger]).toBeUndefined();
  });
});

describe('notifications through the sync engine', () => {
  async function withNotifications() {
    const base = await setup();
    const shown: { title: string; body: string }[] = [];
    const closed: string[] = [];
    const api: NotificationApi = {
      permission: () => 'granted',
      request: () => Promise.resolve('granted'),
      show: ({ title, body, tag }) => {
        shown.push({ title, body });
        return { close: () => closed.push(tag) };
      },
    };
    const notifications = new NotificationService({
      stores: base.stores,
      api,
      clock: base.scheduler,
      source: base.sync,
    });
    notifications.start();
    return { ...base, shown, closed, notifications };
  }

  it('announces a reaction while the user is away and withdraws it when the phone reads it', async () => {
    const { backend, sync, conv, selfId, peerOf, away, ownMessage, react, shown, closed } =
      await withNotifications();
    await ownMessage(NOW + 1, { body: 'Where to eat?' });
    away();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toMatch(/reacted 👍 to: Where to eat\?$/u);
    backend.emit('readSync', { messages: [{ authorId: selfId, sentAt: NOW + 1 }] });
    await sync.idle();
    expect(closed).toEqual([`snowdrop:${conv}`]);
  });

  it('withdraws it when the user reads the chat in Snowdrop', async () => {
    const { sync, conv, peerOf, away, ownMessage, react, shown, closed } =
      await withNotifications();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(shown).toHaveLength(1);
    await sync.markConversationRead(conv);
    expect(closed).toEqual([`snowdrop:${conv}`]);
  });

  it('withdraws it when the reaction is taken back', async () => {
    const { sync, conv, peerOf, away, ownMessage, react, shown, closed } =
      await withNotifications();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 1, peerOf(conv), '👍', true);
    await sync.idle();
    expect(shown).toHaveLength(1);
    expect(closed).toEqual([`snowdrop:${conv}`]);
  });

  it('announces nothing during the catch-up hold, but still keeps it unread for the phone', async () => {
    const { stores, sync, conv, peerOf, markRead, away, ownMessage, react, shown } =
      await withNotifications();
    await ownMessage(NOW + 1);
    away();
    stores.session.getState().setNotificationsHeld(true);
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(shown).toEqual([]);
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a reaction to a chat the user is reading, and reads it', async () => {
    const { sync, conv, peerOf, markRead, view, ownMessage, react, shown } =
      await withNotifications();
    await ownMessage(NOW + 1);
    view();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    expect(shown).toEqual([]);
    expect(markRead).toHaveBeenCalledOnce();
  });

  it('withdraws a message notification when the message is deleted for everyone', async () => {
    const { backend, sync, conv, peerOf, away, shown, closed } = await withNotifications();
    away();
    backend.deliver(message(conv, peerOf(conv), NOW + 1, { body: 'oops' }));
    await sync.idle();
    expect(shown).toHaveLength(1);
    backend.emit('messageDeleted', {
      conversationId: conv,
      authorId: peerOf(conv),
      targetSentAt: NOW + 1,
    });
    await sync.idle();
    expect(closed).toEqual([`snowdrop:${conv}`]);
  });

  it('withdraws a message notification when the chat is read on the phone', async () => {
    const { backend, sync, conv, peerOf, away, shown, closed } = await withNotifications();
    away();
    backend.deliver(message(conv, peerOf(conv), NOW + 1));
    await sync.idle();
    expect(shown).toHaveLength(1);
    backend.emit('readSync', { messages: [{ authorId: peerOf(conv), sentAt: NOW + 1 }] });
    await sync.idle();
    expect(closed).toEqual([`snowdrop:${conv}`]);
  });
});

describe('read on the phone earlier than it is drained', () => {
  const timed = (conv: ConversationId, author: string, sentAt: number) =>
    message(conv, author, sentAt, { expiresAfterReadMs: HOUR });

  it('counts the timer from the phone’s read time, so a long-due message goes at once', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, away } = await setup();
    away();
    const m = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(m);
    await sync.idle();
    // Read on the phone a minute in, drained five hours later (Snowdrop was closed).
    scheduler.advance(5 * HOUR);
    backend.emit('readSync', {
      readAt: NOW + 60_000,
      messages: [{ authorId: peerOf(conv), sentAt: NOW + 1 }],
    });
    await sync.idle();
    expect((await repository.get(m.id))?.expiresAt).toBe(NOW + 60_000 + HOUR);
    scheduler.advance(1);
    await sync.idle();
    expect(await repository.get(m.id)).toBeUndefined();
  });

  it('never counts from the future, nor without a read time', async () => {
    const { backend, scheduler, repository, sync, conv, peerOf, away } = await setup();
    away();
    const future = timed(conv, peerOf(conv), NOW + 1);
    const unknown = timed(conv, peerOf(conv), NOW + 2);
    backend.deliver(future);
    backend.deliver(unknown);
    await sync.idle();
    backend.emit('readSync', {
      readAt: NOW + 10 * HOUR,
      messages: [{ authorId: peerOf(conv), sentAt: NOW + 1 }],
    });
    await sync.idle();
    expect((await repository.get(future.id))?.expiresAt).toBe(scheduler.now() + HOUR);
    backend.emit('readSync', { messages: [{ authorId: peerOf(conv), sentAt: NOW + 2 }] });
    await sync.idle();
    expect((await repository.get(unknown.id))?.expiresAt).toBe(scheduler.now() + HOUR);
  });

  it('counts a message read by replying from another device from that reply’s time', async () => {
    const { repository, scheduler, sync, conv, peerOf, away, ownMessage, backend } = await setup();
    away();
    const waiting = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(waiting);
    await sync.idle();
    scheduler.advance(2 * HOUR);
    await ownMessage(NOW + 5 * 60_000);
    expect((await repository.get(waiting.id))?.expiresAt).toBe(NOW + 5 * 60_000 + HOUR);
  });

  it('starts it after a restart, from what is still unread in storage', async () => {
    const first = await setup();
    first.away();
    const m = timed(first.conv, first.peerOf(first.conv), NOW + 1);
    first.backend.deliver(m);
    await first.sync.idle();
    await first.sync.stop();
    // A new run on the same storage: nothing in memory remembers the message.
    const scheduler = new ManualScheduler(NOW);
    const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
    const sync = new SyncService({
      backend,
      repository: first.repository,
      stores: createStores(),
      clock: scheduler,
      scheduler,
    });
    await sync.start();
    await sync.idle();
    scheduler.advance(60_000);
    backend.emit('readSync', {
      readAt: NOW + 30_000,
      messages: [{ authorId: first.peerOf(first.conv), sentAt: NOW + 1 }],
    });
    await sync.idle();
    expect((await first.repository.get(m.id))?.expiresAt).toBe(NOW + 30_000 + HOUR);
    await sync.stop();
  });

  it('still starts the timer of a live message that an imported copy was merged into', async () => {
    const { repository, scheduler, sync, backend, conv, peerOf, away } = await setup();
    away();
    const live = timed(conv, peerOf(conv), NOW + 1);
    backend.deliver(live);
    await sync.idle();
    await repository.upsertMany([{ ...live, historyCursor: '5' }], {
      backfill: false,
      merge: mergeDuplicate,
    });
    expect(await repository.get(live.id)).toMatchObject({
      historyCursor: '5',
      expiresAfterReadMs: HOUR,
    });
    await sync.markConversationRead(conv);
    expect((await repository.get(live.id))?.expiresAt).toBe(scheduler.now() + HOUR);
  });
});

describe('a read sync of reactions that does not go through', () => {
  it('keeps them unread after a failure, and tries again the next time the chat is read', async () => {
    const { stores, sync, conv, selfId, peerOf, markRead, away, ownMessage, react, onError } =
      await setup();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    markRead.mockRejectedValueOnce(new Error('offline'));
    await sync.markConversationRead(conv);
    expect(onError).toHaveBeenCalled();
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
    // The daemon answers, but the own devices were not reached.
    markRead.mockResolvedValueOnce({ receipt: 'none', sync: 'network' });
    await sync.markConversationRead(conv);
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(3);
    expect(markRead).toHaveBeenLastCalledWith(conv, [{ authorId: selfId, sentAt: NOW + 1 }], {
      syncOnly: true,
    });
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
  });

  it('does not send the same targets twice while a sync is on its way', async () => {
    const { sync, conv, peerOf, markRead, away, ownMessage, react } = await setup();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    await sync.idle();
    await Promise.all([sync.markConversationRead(conv), sync.markConversationRead(conv)]);
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});

describe('reactions that arrive before their message', () => {
  it('count as news once the message turns up', async () => {
    const { stores, sync, conv, peerOf, away, ownMessage, react, events } = await setup();
    away();
    const seen = events('reactionActivity');
    react(NOW + 7, peerOf(conv), '👍');
    await sync.idle();
    expect(seen).toEqual([]);
    await ownMessage(NOW + 7);
    expect(seen.map((e) => [e.kind, e.emoji, e.live])).toEqual([['react', '👍', true]]);
    expect(seen[0]?.message.reactions.map((r) => r.emoji)).toEqual(['👍']);
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 7]);
  });

  it('are announced, and read straight away when the user is looking', async () => {
    const { sync, conv, peerOf, markRead, view, ownMessage, react, events } = await setup();
    const seen = events('reactionActivity');
    view();
    react(NOW + 7, peerOf(conv), '👍');
    await sync.idle();
    await ownMessage(NOW + 7);
    expect(seen).toHaveLength(1);
    expect(markRead).toHaveBeenCalledOnce();
  });

  it('only the last word of each person counts, and a stale one not at all', async () => {
    const { stores, scheduler, sync, conv, peerOf, away, ownMessage, react, events } =
      await setup();
    away();
    const seen = events('reactionActivity');
    react(NOW + 7, peerOf(conv), '👍');
    react(NOW + 7, peerOf(conv), '👍', true);
    react(NOW + 9, peerOf(conv), '👍');
    await sync.idle();
    scheduler.advance(PENDING_OPS_TTL_MS + 60_000);
    react(NOW + 8, peerOf(conv), '👍');
    react(NOW + 8, peerOf(conv), '❤️');
    await sync.idle();
    await ownMessage(NOW + 7);
    await ownMessage(NOW + 8);
    await ownMessage(NOW + 9);
    expect(seen.map((e) => [e.message.sentAt, e.emoji])).toEqual([[NOW + 8, '❤️']]);
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 8]);
  });

  it('are kept quiet by the catch-up hold, but still told to the phone', async () => {
    const base = await setup();
    const shown: string[] = [];
    const notifications = new NotificationService({
      stores: base.stores,
      api: {
        permission: () => 'granted',
        request: () => Promise.resolve('granted'),
        show: ({ body }) => {
          shown.push(body);
          return { close: () => undefined };
        },
      },
      clock: base.scheduler,
      source: base.sync,
    });
    notifications.start();
    base.away();
    base.stores.session.getState().setNotificationsHeld(true);
    base.react(NOW + 7, base.peerOf(base.conv), '👍');
    await base.sync.idle();
    await base.ownMessage(NOW + 7);
    expect(shown).toEqual([]);
    await base.sync.markConversationRead(base.conv);
    expect(base.markRead).toHaveBeenCalledOnce();
    base.stores.session.getState().setNotificationsHeld(false);
    base.react(NOW + 20, base.peerOf(base.conv), '👍');
    await base.sync.idle();
    await base.ownMessage(NOW + 20, { body: 'later' });
    expect(shown).toHaveLength(1);
    notifications.stop();
  });
});

describe('a reaction taken back', () => {
  it('leaves nothing to read, so no sync is sent for it', async () => {
    const { stores, sync, conv, peerOf, markRead, away, ownMessage, react } = await setup();
    await ownMessage(NOW + 1);
    away();
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 1, peerOf(conv), '👍', true);
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toBeUndefined();
    await sync.markConversationRead(conv);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('keeps the message unread while another person’s reaction is still on it', async () => {
    const { stores, sync, conv, peerOf, away, ownMessage, react, backend, selfId } = await setup();
    await ownMessage(NOW + 1);
    away();
    const other = backend.world.conversations
      .get(conv)!
      .memberIds.find((m) => m !== selfId && m !== peerOf(conv))!;
    react(NOW + 1, other, '❤️');
    react(NOW + 1, peerOf(conv), '👍');
    react(NOW + 1, peerOf(conv), '👍', true);
    await sync.idle();
    expect(stores.local.getState().unreadActivity[conv]).toEqual([NOW + 1]);
  });
});

describe('the timer of a message sent from here', () => {
  it('is the conversation’s timer when the send goes out, not when it is acknowledged', async () => {
    const { backend, repository, stores, send, conv } = await setup();
    const current = stores.conversations.getState().byId[conv]!;
    stores.conversations.getState().upsert({ ...current, expireTimerSec: 30 });
    const real = backend.send.bind(backend);
    vi.spyOn(backend, 'send').mockImplementation(async (input) => {
      // The timer is switched off while the send is in flight.
      const now = stores.conversations.getState().byId[conv]!;
      stores.conversations.getState().upsert({ ...now, expireTimerSec: 0 });
      return real(input);
    });
    await send.send({ conversationId: conv, text: 'in flight', mentionIds: [], attachments: [] });
    const sent = (await repository.listAfter(conv, 0)).find((m) => m.body === 'in flight')!;
    expect(sent.expiresAt).toBe(sent.sentAt + 30_000);
  });
});
