import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import {
  MENTION_PLACEHOLDER,
  messageId,
  pendingMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores, messagesSelectors, TYPING_TTL_MS, typingSelectors } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { SendService } from './SendService';
import { SyncService } from './SyncService';
import type { DraftPipeline, OutgoingDraft } from './types';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function setup(options: { latencyMs?: number; pipeline?: DraftPipeline } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
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
  if (options.latencyMs) Object.assign(backend, { latencyMs: options.latencyMs });
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    onError,
    newNonce: (() => {
      let n = 0;
      return () => `nonce-${++n}`;
    })(),
    ...(options.pipeline ? { pipeline: options.pipeline } : {}),
  });
  const history = new HistoryService({ backend, repository, stores, pageSize: 20, onError });
  const conv = (key: string) => backend.world.conversationIds.get(key)!;
  const selfId = backend.world.self.id;
  return { scheduler, backend, repository, stores, sync, send, history, onError, conv, selfId };
}

const incoming = (
  conversationId: ConversationId,
  authorId: string,
  sentAt: number,
  extra: Partial<Message> = {},
): Message => ({
  id: messageId(authorId, sentAt),
  conversationId,
  authorId,
  sentAt,
  receivedAt: sentAt,
  body: 'hello',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
  ...extra,
});

const draft = (
  conversationId: ConversationId,
  text: string,
  extra: Partial<OutgoingDraft> = {},
): OutgoingDraft => ({
  conversationId,
  text,
  mentionIds: [],
  attachments: [],
  ...extra,
});

describe('SyncService', () => {
  it('performs the initial sync into stores and repository', async () => {
    const { stores, backend, repository, conv } = await setup();
    const session = stores.session.getState();
    expect(session).toMatchObject({ status: 'online', ready: true, backendKind: 'mock' });
    expect(session.self?.id).toBe(backend.world.self.id);
    expect(Object.keys(stores.contacts.getState().byId)).toHaveLength(26);
    expect(Object.keys(stores.conversations.getState().byId)).toHaveLength(22);
    expect(await repository.count(conv('kiln-eng'))).toBeGreaterThan(0);
    expect(stores.conversations.getState().unread[conv('kiln-eng')]?.count).toBe(4);
    expect(stores.conversations.getState().unread[conv('kiln-design')]?.count ?? 0).toBe(0);
  });

  it('counts incoming messages and mentions for background conversations', async () => {
    const { stores, backend, sync, conv, selfId } = await setup();
    const id = conv('kiln-design');
    const author = backend.world.conversations.get(id)!.memberIds[1]!;
    backend.deliver(incoming(id, author, NOW + 1));
    backend.deliver(
      incoming(id, author, NOW + 2, {
        body: MENTION_PLACEHOLDER,
        ranges: [{ start: 0, length: 1, mentionId: selfId }],
      }),
    );
    await sync.idle();
    expect(stores.conversations.getState().unread[id]).toEqual({ count: 2, mentions: 1 });
    expect(stores.conversations.getState().byId[id]?.lastActivityAt).toBe(NOW + 2);
    expect(
      messagesSelectors
        .list(id)(stores.messages.getState())
        .map((m) => m.sentAt),
    ).toEqual([NOW + 1, NOW + 2]);
  });

  it('auto-marks read (with receipts) when the conversation is being viewed', async () => {
    const { stores, backend, sync, conv } = await setup();
    const id = conv('kiln-eng');
    const markRead = vi.spyOn(backend, 'markRead');
    stores.ui.getState().selectConversation(id);
    const author = backend.world.conversations.get(id)!.memberIds[1]!;
    backend.deliver(incoming(id, author, NOW + 5));
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(0);
    expect(stores.conversations.getState().readCursors[id]).toBe(NOW + 5);
    // The 4 pre-existing unread + the new one are acknowledged together.
    expect(markRead.mock.calls[0]?.[1]).toHaveLength(5);
  });

  it('skips read receipts when disabled', async () => {
    const { stores, backend, sync, conv } = await setup();
    stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    expect(markRead).not.toHaveBeenCalled();
    expect(stores.conversations.getState().unread[conv('crux')]?.count).toBe(0);
  });

  it('applies edits, reactions and deletions in order, even when they arrive together', async () => {
    const { stores, backend, sync, repository, conv } = await setup();
    const id = conv('books');
    const author = backend.world.conversations.get(id)!.memberIds[1]!;
    const msg = incoming(id, author, NOW + 10);
    backend.deliver(msg);
    backend.emit('messageEdited', {
      conversationId: id,
      authorId: author,
      targetSentAt: NOW + 10,
      body: 'hello!',
      ranges: [],
      editedAt: NOW + 11,
    });
    backend.emit('reaction', {
      conversationId: id,
      targetAuthorId: author,
      targetSentAt: NOW + 10,
      reaction: { emoji: '🔥', authorId: author, at: NOW + 12 },
      remove: false,
    });
    await sync.idle();
    const stored = await repository.get(msg.id);
    expect(stored).toMatchObject({ body: 'hello!', edits: 1 });
    expect(stored?.reactions).toHaveLength(1);
    expect(messagesSelectors.message(id, msg.id)(stores.messages.getState())?.body).toBe('hello!');

    const before = stores.conversations.getState().unread[id]!.count;
    backend.emit('messageDeleted', {
      conversationId: id,
      authorId: author,
      targetSentAt: NOW + 10,
    });
    await sync.idle();
    expect((await repository.get(msg.id))?.deleted).toBe(true);
    expect(stores.conversations.getState().unread[id]!.count).toBe(before - 1);
  });

  it('isolates a failing handler so later events still apply', async () => {
    const { backend, sync, repository, conv, onError } = await setup();
    const id = conv('books');
    vi.spyOn(repository, 'update').mockRejectedValueOnce(new Error('disk full'));
    backend.emit('messageEdited', {
      conversationId: id,
      authorId: 'x',
      targetSentAt: 1,
      body: '',
      ranges: [],
      editedAt: 2,
    });
    backend.deliver(incoming(id, 'someone', NOW + 20));
    await sync.idle();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'sync: messageEdited handler failed');
    expect(await repository.get(messageId('someone', NOW + 20))).toBeDefined();
  });

  it('expires typing indicators on the scheduler', async () => {
    const { stores, backend, scheduler, conv } = await setup();
    const id = conv('crux');
    backend.emit('typing', { conversationId: id, authorId: 'a', typing: true });
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual(['a']);
    scheduler.advance(TYPING_TTL_MS - 1);
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual(['a']);
    scheduler.advance(1);
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual([]);
  });

  it('clears an author’s typing indicator when their message arrives', async () => {
    const { stores, backend, sync, conv } = await setup();
    const id = conv('crux');
    backend.emit('typing', { conversationId: id, authorId: 'a', typing: true });
    backend.deliver(incoming(id, 'a', NOW + 1));
    await sync.idle();
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual([]);
  });

  it('applies read sync from another device', async () => {
    const { stores, backend, sync, repository, conv } = await setup();
    const id = conv('crux');
    const unread = await repository.listAfter(id, stores.conversations.getState().readCursors[id]!);
    const others = unread.filter((m) => m.authorId !== backend.world.self.id);
    const third = others[2]!;
    backend.emit('readSync', { messages: [{ authorId: third.authorId, sentAt: third.sentAt }] });
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(others.length - 3);
  });

  it('merges conversation updates without losing local activity', async () => {
    const { stores, backend, conv } = await setup();
    const id = conv('books');
    const before = stores.conversations.getState().byId[id]!;
    backend.emit('conversationUpdated', { ...before, title: 'Renamed', lastActivityAt: 0 });
    expect(stores.conversations.getState().byId[id]).toMatchObject({
      title: 'Renamed',
      lastActivityAt: before.lastActivityAt,
    });
  });

  it('reports failed initial sync as an error state', async () => {
    const scheduler = new ManualScheduler(NOW);
    const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler });
    vi.spyOn(backend, 'listContacts').mockRejectedValue(new Error('boom'));
    const stores = createStores();
    const sync = new SyncService({
      backend,
      repository: new MemoryMessageRepository(),
      stores,
      clock: scheduler,
      scheduler,
      onError: vi.fn(),
    });
    await expect(sync.start()).rejects.toThrow('boom');
    expect(stores.session.getState()).toMatchObject({
      status: 'error',
      error: 'boom',
      ready: false,
    });
  });
});

describe('SendService', () => {
  it('shows a pending message, then reconciles it with the server identity', async () => {
    const { stores, send, repository, scheduler, conv, selfId } = await setup({ latencyMs: 100 });
    const id = conv('kiln-eng');
    const promise = send.send(draft(id, 'hello **world**'));
    await flush();
    const pending = stores.messages.getState().findByNonce(id, 'nonce-1');
    expect(pending).toMatchObject({
      id: pendingMessageId('nonce-1'),
      status: 'pending',
      body: 'hello world',
    });
    expect(pending?.ranges).toEqual([{ start: 6, length: 5, style: 'bold' }]);

    scheduler.advance(100);
    await expect(promise).resolves.toBe('nonce-1');
    const list = messagesSelectors.list(id)(stores.messages.getState());
    const sent = list.at(-1)!;
    expect(sent).toMatchObject({
      id: messageId(selfId, NOW + 100),
      status: 'sent',
      nonce: 'nonce-1',
    });
    expect(list.some((m) => m.id === pendingMessageId('nonce-1'))).toBe(false);
    expect(await repository.get(sent.id)).toMatchObject({ body: 'hello world' });
    expect((await repository.get(sent.id))?.nonce).toBeUndefined();
    expect(stores.conversations.getState().unread[id]?.count).toBe(0);
  });

  it('advances status on receipts', async () => {
    const { stores, send, sync, scheduler, conv } = await setup();
    const id = conv('dm-ines');
    await send.send(draft(id, 'ping'));
    scheduler.advance(10_000);
    await sync.idle();
    expect(messagesSelectors.list(id)(stores.messages.getState()).at(-1)?.status).toBe('read');
  });

  it('marks failures, retries and discards', async () => {
    const { stores, send, backend, conv, onError } = await setup();
    const id = conv('kiln-eng');
    backend.failNext();
    await send.send(draft(id, 'flaky'));
    expect(stores.messages.getState().findByNonce(id, 'nonce-1')?.status).toBe('failed');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'send failed');

    await send.retry(id, 'nonce-1');
    expect(stores.messages.getState().findByNonce(id, 'nonce-1')?.status).toBe('sent');

    backend.failNext();
    await send.send(draft(id, 'doomed'));
    send.discard(id, 'nonce-2');
    expect(stores.messages.getState().findByNonce(id, 'nonce-2')).toBeUndefined();
  });

  it('attaches mentions after markdown parsing and skips empty drafts', async () => {
    const { stores, send, conv, backend } = await setup();
    const id = conv('kiln-eng');
    const target = backend.world.conversations.get(id)!.memberIds[1]!;
    await send.send(draft(id, `**hey** ${MENTION_PLACEHOLDER} look`, { mentionIds: [target] }));
    const sent = messagesSelectors.list(id)(stores.messages.getState()).at(-1)!;
    expect(sent.body).toBe(`hey ${MENTION_PLACEHOLDER} look`);
    expect(sent.ranges).toContainEqual({ start: 4, length: 1, mentionId: target });
    expect(await send.send(draft(id, '   '))).toBeNull();
  });

  it('sends raw text when markdown is disabled', async () => {
    const { stores, send, conv } = await setup();
    stores.settings.getState().update('behaviour', { markdown: false });
    const id = conv('kiln-eng');
    await send.send(draft(id, '**literal**'));
    expect(messagesSelectors.list(id)(stores.messages.getState()).at(-1)).toMatchObject({
      body: '**literal**',
      ranges: [],
    });
  });

  it('runs the draft pipeline', async () => {
    const pipeline: DraftPipeline = {
      transform: (d) => Promise.resolve({ ...d, text: d.text.toUpperCase() }),
      allowsTyping: () => true,
    };
    const { stores, send, conv } = await setup({ pipeline });
    const id = conv('kiln-eng');
    await send.send(draft(id, 'quiet'));
    expect(messagesSelectors.list(id)(stores.messages.getState()).at(-1)?.body).toBe('QUIET');
  });

  it('edits optimistically and rolls back on failure', async () => {
    const { stores, send, backend, repository, conv } = await setup();
    const id = conv('dm-ines');
    await send.send(draft(id, 'tpyo'));
    const mine = messagesSelectors.list(id)(stores.messages.getState()).at(-1)!;

    expect(await send.edit(id, mine.id, 'typo')).toBe(true);
    expect(messagesSelectors.message(id, mine.id)(stores.messages.getState())).toMatchObject({
      body: 'typo',
      edits: 1,
    });
    expect(await repository.get(mine.id)).toMatchObject({ body: 'typo', edits: 1 });

    backend.failNext();
    expect(await send.edit(id, mine.id, 'typo again')).toBe(false);
    const reverted = messagesSelectors.message(id, mine.id)(stores.messages.getState());
    expect(reverted).toMatchObject({ body: 'typo', edits: 1 });
    // Unchanged text is a no-op.
    expect(await send.edit(id, mine.id, 'typo')).toBe(false);
  });

  it('toggles reactions and keeps concurrent reactions on rollback', async () => {
    const { stores, send, backend, sync, conv, selfId } = await setup();
    const id = conv('dm-ines');
    await send.send(draft(id, 'react to me'));
    const get = () => messagesSelectors.list(id)(stores.messages.getState()).at(-1)!;

    await send.toggleReaction(id, get(), '👍');
    expect(get().reactions.map((r) => [r.authorId, r.emoji])).toEqual([[selfId, '👍']]);
    await send.toggleReaction(id, get(), '👍');
    expect(get().reactions).toEqual([]);

    backend.failNext();
    const pending = send.react(id, get(), '🔥');
    backend.emit('reaction', {
      conversationId: id,
      targetAuthorId: selfId,
      targetSentAt: get().sentAt,
      reaction: { emoji: '❤️', authorId: 'peer', at: NOW },
      remove: false,
    });
    expect(await pending).toBe(false);
    await sync.idle();
    expect(get().reactions.map((r) => r.emoji)).toEqual(['❤️']);
  });

  it('deletes own messages for everyone', async () => {
    const { stores, send, conv } = await setup();
    const id = conv('dm-ines');
    await send.send(draft(id, 'oops'));
    const mine = messagesSelectors.list(id)(stores.messages.getState()).at(-1)!;
    expect(await send.deleteForEveryone(id, mine)).toBe(true);
    expect(messagesSelectors.message(id, mine.id)(stores.messages.getState())).toMatchObject({
      deleted: true,
      body: '',
    });
  });

  it('throttles typing and honours the setting and guards', async () => {
    let allow = true;
    const pipeline: DraftPipeline = {
      transform: (d) => Promise.resolve(d),
      allowsTyping: () => allow,
    };
    const { send, backend, scheduler, stores, conv } = await setup({ pipeline });
    const id = conv('dm-ines');
    await send.setTyping(id, true);
    await send.setTyping(id, true);
    scheduler.advance(10_000);
    await send.setTyping(id, true);
    await send.setTyping(id, false);
    await send.setTyping(id, false);
    expect(backend.typingSent.map((t) => t.typing)).toEqual([true, true, false]);

    allow = false;
    await send.setTyping(id, true);
    stores.settings.getState().update('behaviour', { sendTypingIndicators: false });
    allow = true;
    await send.setTyping(id, true);
    expect(backend.typingSent).toHaveLength(3);
  });
});

describe('HistoryService', () => {
  it('loads the newest page from the repository and backfills older pages from the backend', async () => {
    const { stores, history, backend, conv } = await setup();
    const id = conv('crux');
    const full = backend.world.histories.get(id)!;
    await history.ensureLoaded(id);
    let list = messagesSelectors.list(id)(stores.messages.getState());
    expect(list.map((m) => m.id)).toEqual(full.slice(-20).map((m) => m.id));
    expect(stores.messages.getState().windows[id]?.hasMoreBefore).toBe(true);

    for (let i = 0; i < 10 && stores.messages.getState().windows[id]?.hasMoreBefore; i++) {
      await history.loadOlder(id);
    }
    list = messagesSelectors.list(id)(stores.messages.getState());
    expect(list.map((m) => m.id)).toEqual(full.map((m) => m.id));
    expect(stores.messages.getState().windows[id]).toMatchObject({
      hasMoreBefore: false,
      loading: false,
    });
  });

  it('coalesces concurrent loads', async () => {
    const { history, repository, conv } = await setup();
    const id = conv('crux');
    await history.ensureLoaded(id);
    const spy = vi.spyOn(repository, 'page');
    await Promise.all([history.loadOlder(id), history.loadOlder(id)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps live messages that arrived before the window loaded', async () => {
    const { stores, history, backend, sync, conv } = await setup();
    const id = conv('books');
    backend.deliver(incoming(id, 'someone', NOW + 1));
    await sync.idle();
    await history.ensureLoaded(id);
    const list = messagesSelectors.list(id)(stores.messages.getState());
    expect(list.at(-1)?.sentAt).toBe(NOW + 1);
    expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
  });
});

describe('SyncService hooks', () => {
  it('emits processed messages after they are stored', async () => {
    const { backend, sync, repository, conv } = await setup();
    const seen: boolean[] = [];
    sync.on('message', (m) => {
      void repository.get(m.id).then((stored) => seen.push(stored !== undefined));
    });
    backend.deliver(incoming(conv('books'), 'someone', NOW + 1));
    await sync.idle();
    await flush();
    expect(seen).toEqual([true]);
  });
});
