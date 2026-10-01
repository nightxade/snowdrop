import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import {
  MENTION_PLACEHOLDER,
  directConversationId,
  messageId,
  pendingMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import {
  createStores,
  localSelectors,
  messagesSelectors,
  TYPING_TTL_MS,
  typingSelectors,
  type Stores,
} from '@/core/stores';
import { HistoryService } from './HistoryService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';
import type { DraftPipeline, OutgoingDraft } from './types';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface SetupOptions {
  latencyMs?: number;
  pipeline?: DraftPipeline;
  start?: boolean;
  repository?: MemoryMessageRepository;
  stores?: Stores;
  noServerHistory?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  if (options.noServerHistory) Object.assign(backend, { fetchHistory: undefined });
  const repository = options.repository ?? new MemoryMessageRepository();
  const stores = options.stores ?? createStores();
  const onError = vi.fn();
  const receipts = new ReceiptBuffer();
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    receipts,
    onError,
  });
  if (options.start !== false) await sync.start();
  if (options.latencyMs) Object.assign(backend, { latencyMs: options.latencyMs });
  let n = 0;
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    onError,
    newNonce: () => `nonce-${++n}`,
    ...(options.pipeline ? { pipeline: options.pipeline } : {}),
  });
  const history = new HistoryService({ backend, repository, stores, pageSize: 20, onError });
  const conv = (key: string) => backend.world.conversationIds.get(key)!;
  const selfId = backend.world.self.id;
  const memberOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const list = (id: ConversationId) => messagesSelectors.list(id)(stores.messages.getState());
  return {
    scheduler,
    backend,
    repository,
    stores,
    sync,
    send,
    history,
    onError,
    conv,
    selfId,
    memberOf,
    list,
  };
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
  receivedAt: NOW,
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

describe('SyncService: initial sync', () => {
  it('fills stores and repository', async () => {
    const { stores, backend, repository, conv } = await setup();
    expect(stores.session.getState()).toMatchObject({
      status: 'online',
      ready: true,
      backendKind: 'mock',
    });
    expect(stores.session.getState().self?.id).toBe(backend.world.self.id);
    expect(Object.keys(stores.contacts.getState().byId)).toHaveLength(26);
    expect(Object.keys(stores.conversations.getState().byId)).toHaveLength(22);
    expect(await repository.count(conv('orchard-eng'))).toBeGreaterThan(0);
    expect(stores.conversations.getState().unread[conv('orchard-eng')]?.count).toBe(4);
    expect(stores.conversations.getState().unread[conv('orchard-design')]?.count ?? 0).toBe(0);
  });

  it('(A) buffers events until the initial sync is done, so offline messages count as unread', async () => {
    const scheduler = new ManualScheduler(NOW);
    const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler });
    Object.assign(backend, { fetchHistory: undefined }); // like signal-cli: no server history
    const stores = createStores();
    const sync = new SyncService({
      backend,
      repository: new MemoryMessageRepository(),
      stores,
      clock: scheduler,
      scheduler,
      onError: vi.fn(),
    });
    const group = backend.world.conversationIds.get('books')!;
    const other = backend.world.conversations.get(group)!.memberIds[1]!;
    const connect = backend.connect.bind(backend);
    // The daemon flushes queued envelopes right after connecting.
    backend.connect = async () => {
      await connect();
      backend.deliver(incoming(group, other, NOW + 5000, { body: 'sent while you were away' }));
    };
    await sync.start();
    await sync.idle();
    expect(stores.conversations.getState().unread[group]).toEqual({ count: 1, mentions: 0 });
  });

  it('(L) restarts cleanly after a failed start without double subscriptions', async () => {
    const s = await setup({ start: false });
    const connect = s.backend.connect.bind(s.backend);
    let fail = true;
    s.backend.connect = async () => {
      if (fail) {
        fail = false;
        throw new Error('down');
      }
      return connect();
    };
    await expect(s.sync.start()).rejects.toThrow('down');
    expect(s.stores.session.getState()).toMatchObject({
      status: 'error',
      error: 'down',
      ready: false,
    });
    await s.sync.start();
    // start() is idempotent while running, too.
    await s.sync.start();
    s.stores.ui.getState().setWindowFocused(false);
    const group = s.conv('books');
    const before = s.stores.conversations.getState().unread[group]?.count ?? 0;
    s.backend.emit('message', incoming(group, s.memberOf(group), NOW + 99_999));
    await s.sync.idle();
    expect(s.stores.conversations.getState().unread[group]?.count).toBe(before + 1);
  });

  it('can stop and start again', async () => {
    const s = await setup();
    await s.sync.stop();
    expect(s.stores.session.getState()).toMatchObject({ status: 'offline', ready: false });
    await s.sync.start();
    const group = s.conv('books');
    const before = s.stores.conversations.getState().unread[group]?.count ?? 0;
    s.backend.emit('message', incoming(group, s.memberOf(group), NOW + 1));
    await s.sync.idle();
    expect(s.stores.conversations.getState().unread[group]?.count).toBe(before + 1);
  });
});

describe('SyncService: events', () => {
  it('counts incoming messages and mentions for background conversations', async () => {
    const { stores, backend, sync, conv, selfId, memberOf, history, list } = await setup();
    const id = conv('orchard-design');
    await history.open(id);
    backend.deliver(incoming(id, memberOf(id), NOW + 1));
    backend.deliver(
      incoming(id, memberOf(id), NOW + 2, {
        body: MENTION_PLACEHOLDER,
        ranges: [{ start: 0, length: 1, mentionId: selfId }],
      }),
    );
    await sync.idle();
    expect(stores.conversations.getState().unread[id]).toEqual({ count: 2, mentions: 1 });
    expect(
      list(id)
        .slice(-2)
        .map((m) => m.sentAt),
    ).toEqual([NOW + 1, NOW + 2]);
  });

  it('(D) ignores duplicate deliveries for unread, and keeps later edits/reactions', async () => {
    const { stores, backend, sync, repository, conv, memberOf } = await setup();
    const id = conv('books');
    const author = memberOf(id);
    const before = stores.conversations.getState().unread[id]?.count ?? 0;
    const m = incoming(id, author, NOW + 1000);
    const onMessage = vi.fn();
    sync.on('message', onMessage);
    backend.emit('message', m);
    backend.emit('reaction', {
      conversationId: id,
      targetAuthorId: author,
      targetSentAt: NOW + 1000,
      reaction: { emoji: '🎯', authorId: author, at: NOW },
      remove: false,
    });
    backend.emit('message', m);
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(before + 1);
    expect((await repository.get(m.id))?.reactions).toHaveLength(1);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('(J) counts a message from a sender with a skewed clock', async () => {
    const { stores, backend, sync, conv, memberOf } = await setup();
    stores.ui.getState().setWindowFocused(false);
    const id = conv('books');
    await sync.markConversationRead(id);
    backend.emit(
      'message',
      incoming(id, memberOf(id), NOW - 3_600_000, { body: 'my clock is slow' }),
    );
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(1);
  });

  it('(K) applies edits in order and ignores stale ones', async () => {
    const { backend, sync, repository, conv, memberOf } = await setup();
    const id = conv('books');
    const author = memberOf(id);
    const m = incoming(id, author, NOW + 1000, { body: 'v0' });
    backend.emit('message', m);
    backend.emit('messageEdited', {
      conversationId: id,
      authorId: author,
      targetSentAt: NOW + 1000,
      body: 'v2',
      ranges: [],
      editedAt: NOW + 3000,
    });
    backend.emit('messageEdited', {
      conversationId: id,
      authorId: author,
      targetSentAt: NOW + 1000,
      body: 'v1',
      ranges: [],
      editedAt: NOW + 2000,
    });
    await sync.idle();
    expect(await repository.get(m.id)).toMatchObject({ body: 'v2', edits: 1 });
  });

  it('applies deletions (with admin attribution) and un-counts them', async () => {
    const { stores, backend, sync, repository, conv, memberOf } = await setup();
    const id = conv('books');
    const author = memberOf(id);
    const m = incoming(id, author, NOW + 10);
    backend.deliver(m);
    await sync.idle();
    const before = stores.conversations.getState().unread[id]!.count;
    backend.emit('messageDeleted', {
      conversationId: id,
      authorId: author,
      targetSentAt: NOW + 10,
      deletedBy: 'admin-x',
    });
    await sync.idle();
    expect(await repository.get(m.id)).toMatchObject({ deleted: true, deletedBy: 'admin-x' });
    expect(stores.conversations.getState().unread[id]!.count).toBe(before - 1);
  });

  it('applies pin events', async () => {
    const { backend, sync, repository, conv, memberOf } = await setup();
    const id = conv('books');
    const author = memberOf(id);
    backend.deliver(incoming(id, author, NOW + 10));
    const pin = { conversationId: id, targetAuthorId: author, targetSentAt: NOW + 10, by: author };
    backend.emit('messagePinned', { ...pin, pinned: true });
    await sync.idle();
    expect((await repository.get(messageId(author, NOW + 10)))?.pinned).toBe(true);
    backend.emit('messagePinned', { ...pin, pinned: false });
    await sync.idle();
    expect((await repository.get(messageId(author, NOW + 10)))?.pinned).toBeUndefined();
  });

  it('auto-marks read (with receipts) when the conversation is being viewed', async () => {
    const { stores, backend, sync, conv, memberOf } = await setup();
    const id = conv('orchard-eng');
    const markRead = vi.spyOn(backend, 'markRead');
    stores.ui.getState().selectConversation(id);
    backend.deliver(incoming(id, memberOf(id), NOW + 5));
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(0);
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

  it('expires typing indicators and clears them when the author’s message lands', async () => {
    const { stores, backend, sync, scheduler, conv } = await setup();
    const id = conv('crux');
    backend.emit('typing', { conversationId: id, authorId: 'a', typing: true });
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual(['a']);
    scheduler.advance(TYPING_TTL_MS);
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual([]);
    backend.emit('typing', { conversationId: id, authorId: 'b', typing: true });
    backend.deliver(incoming(id, 'b', NOW + 1));
    await sync.idle();
    expect(typingSelectors.typers(id)(stores.typing.getState())).toEqual([]);
  });

  it('applies read sync from another device', async () => {
    const { stores, backend, sync, repository, conv, selfId } = await setup();
    const id = conv('crux');
    const unread = await repository.listAfter(id, stores.conversations.getState().readCursors[id]!);
    const others = unread.filter((m) => m.authorId !== selfId);
    const third = others[2]!;
    backend.emit('readSync', { messages: [{ authorId: third.authorId, sentAt: third.sentAt }] });
    await sync.idle();
    expect(stores.conversations.getState().unread[id]?.count).toBe(others.length - 3);
  });

  it('(E) keeps local state when the backend updates a conversation', async () => {
    const { stores, backend, sync, conv } = await setup();
    const id = conv('books');
    stores.local
      .getState()
      .patchConversation(id, { pinned: true, muted: true, archived: true, draft: 'wip' });
    backend.emit('conversationUpdated', {
      ...backend.world.conversations.get(id)!,
      title: 'Renamed',
      lastActivityAt: 0,
    });
    await sync.idle();
    expect(stores.conversations.getState().byId[id]?.title).toBe('Renamed');
    expect(localSelectors.conversation(id)(stores.local.getState())).toEqual({
      pinned: true,
      muted: true,
      archived: true,
      draft: 'wip',
    });
  });

  it('synthesises a DM for an unknown sender and coalesces conversation refreshes', async () => {
    const { stores, backend, sync } = await setup();
    const list = vi.spyOn(backend, 'listConversations');
    const stranger = 'b0c1d2e3-0000-4000-8000-000000000001';
    const dm = directConversationId(stranger);
    backend.emit('message', incoming(dm, stranger, NOW + 1, { body: 'hi, new here' }));
    backend.emit('message', incoming(dm, stranger, NOW + 2, { body: 'again' }));
    await sync.idle();
    await flush();
    expect(stores.conversations.getState().byId[dm]).toMatchObject({
      kind: 'direct',
      memberIds: [backend.world.self.id, stranger],
    });
    expect(stores.conversations.getState().unread[dm]?.count).toBe(2);
    // Two unknown-conversation messages → at most one refresh plus one follow-up.
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('purges expired disappearing messages', async () => {
    const { backend, sync, scheduler, repository, conv, memberOf, history, list } = await setup();
    const id = conv('crux-trips');
    await history.open(id);
    const m = incoming(id, memberOf(id), NOW + 1, { expiresAt: NOW + 5_000 });
    backend.deliver(m);
    await sync.idle();
    expect(list(id).some((x) => x.id === m.id)).toBe(true);
    scheduler.advance(5_000);
    await sync.idle();
    expect(await repository.get(m.id)).toBeUndefined();
    expect(list(id).some((x) => x.id === m.id)).toBe(false);
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

  it('emits processed (new) messages after they are stored', async () => {
    const { backend, sync, repository, conv } = await setup();
    const seen: boolean[] = [];
    sync.on('message', (m) => {
      void repository.get(m.id).then((stored) => seen.push(stored?.seq !== undefined));
    });
    backend.deliver(incoming(conv('books'), 'someone', NOW + 1));
    await sync.idle();
    await flush();
    expect(seen).toEqual([true]);
  });
});

describe('SendService', () => {
  it('shows a pending message in place, then reconciles it with the server identity', async () => {
    const s = await setup({ latencyMs: 100 });
    const id = s.conv('orchard-eng');
    await s.history.open(id);
    const promise = s.send.send(draft(id, 'hello **world**'));
    await flush();
    const pending = s.stores.messages.getState().findByNonce(id, 'nonce-1');
    expect(pending).toMatchObject({
      id: pendingMessageId('nonce-1'),
      status: 'pending',
      body: 'hello world',
    });
    expect(pending?.ranges).toEqual([{ start: 6, length: 5, style: 'bold' }]);
    // Someone else's message arrives while we wait: ours keeps its earlier place.
    s.backend.deliver(incoming(id, s.memberOf(id), NOW + 50));
    await s.sync.idle();

    s.scheduler.advance(100);
    await expect(promise).resolves.toBe('nonce-1');
    const tail = s.list(id).slice(-2);
    expect(tail[0]).toMatchObject({
      id: messageId(s.selfId, NOW + 100),
      status: 'sent',
      nonce: 'nonce-1',
    });
    expect(tail[1]?.sentAt).toBe(NOW + 50);
    expect(await s.repository.get(pendingMessageId('nonce-1'))).toBeUndefined();
    expect(await s.repository.get(tail[0]!.id)).toMatchObject({ body: 'hello world' });
    expect(await s.repository.listOutbox()).toEqual([]);
  });

  it('(C) applies a receipt that arrived before the send was acknowledged', async () => {
    const s = await setup({ latencyMs: 100 });
    const id = s.conv('books');
    await s.history.open(id);
    const p = s.send.send(draft(id, 'hi'));
    await flush();
    s.scheduler.advance(99);
    s.backend.emit('receipt', {
      authorId: s.memberOf(id),
      sentAts: [NOW + 100],
      type: 'delivered',
    });
    await s.sync.idle();
    s.scheduler.advance(1);
    await p;
    expect(s.list(id).at(-1)).toMatchObject({ sentAt: NOW + 100, status: 'delivered' });
    expect((await s.repository.get(messageId(s.selfId, NOW + 100)))?.status).toBe('delivered');
  });

  it('(M) merges with a sync echo that beat the acknowledgement, without downgrading status', async () => {
    const s = await setup({ latencyMs: 100 });
    const id = s.conv('books');
    await s.history.open(id);
    const p = s.send.send(draft(id, 'hi'));
    await flush();
    s.scheduler.advance(100);
    s.backend.emit(
      'message',
      incoming(id, s.selfId, NOW + 100, { body: 'hi', status: 'delivered' }),
    );
    await s.sync.idle();
    await p;
    const mine = s.list(id).filter((m) => m.authorId === s.selfId && m.sentAt >= NOW);
    expect(mine.map((m) => [m.id, m.status, m.nonce])).toEqual([
      [messageId(s.selfId, NOW + 100), 'delivered', 'nonce-1'],
    ]);
  });

  it('advances status on receipts', async () => {
    const { stores, send, sync, scheduler, conv, history } = await setup();
    const id = conv('dm-ines');
    await history.open(id);
    await send.send(draft(id, 'ping'));
    scheduler.advance(10_000);
    await sync.idle();
    expect(messagesSelectors.list(id)(stores.messages.getState()).at(-1)?.status).toBe('read');
  });

  it('marks failures, retries and discards', async () => {
    const { stores, send, backend, conv, onError, repository, history } = await setup();
    const id = conv('orchard-eng');
    await history.open(id);
    backend.failNext();
    await send.send(draft(id, 'flaky'));
    expect(stores.messages.getState().findByNonce(id, 'nonce-1')?.status).toBe('failed');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'send failed');
    expect(await repository.listOutbox()).toHaveLength(1);

    await send.retry(id, 'nonce-1');
    expect(stores.messages.getState().findByNonce(id, 'nonce-1')?.status).toBe('sent');

    backend.failNext();
    await send.send(draft(id, 'doomed'));
    await send.discard(id, 'nonce-2');
    expect(stores.messages.getState().findByNonce(id, 'nonce-2')).toBeUndefined();
    expect(await repository.get(pendingMessageId('nonce-2'))).toBeUndefined();
    expect(await repository.listOutbox()).toEqual([]);
  });

  it('(10) restores the outbox after a restart as failed, retryable messages', async () => {
    const repository = new MemoryMessageRepository();
    const first = await setup({ repository });
    const id = first.conv('orchard-eng');
    first.backend.failNext();
    await first.send.send(draft(id, 'written before the crash'));

    // "Reload": fresh stores and services over the same repository.
    const second = await setup({ repository });
    expect(await second.send.restoreOutbox()).toBe(1);
    await second.history.open(id);
    expect(second.stores.messages.getState().findByNonce(id, 'nonce-1')).toMatchObject({
      status: 'failed',
      body: 'written before the crash',
    });
    await second.send.retry(id, 'nonce-1');
    expect(second.list(id).at(-1)).toMatchObject({
      status: 'sent',
      body: 'written before the crash',
    });
  });

  it('attaches mentions after markdown parsing and skips empty drafts', async () => {
    const { send, conv, backend, list, history } = await setup();
    const id = conv('orchard-eng');
    await history.open(id);
    const target = backend.world.conversations.get(id)!.memberIds[1]!;
    await send.send(draft(id, `**hey** ${MENTION_PLACEHOLDER} look`, { mentionIds: [target] }));
    const sent = list(id).at(-1)!;
    expect(sent.body).toBe(`hey ${MENTION_PLACEHOLDER} look`);
    expect(sent.ranges).toContainEqual({ start: 4, length: 1, mentionId: target });
    expect(await send.send(draft(id, '   '))).toBeNull();
  });

  it('(3) honours the draft format regardless of the markdown setting', async () => {
    const { stores, send } = await setup();
    stores.settings.getState().update('behaviour', { markdown: false });
    expect(send.compose('**literal**', []).body).toBe('**literal**');
    expect(send.compose('¯\\\\\\_(ツ)\\_/¯', [], 'markdown').body).toBe('¯\\_(ツ)_/¯');
    stores.settings.getState().update('behaviour', { markdown: true });
    expect(send.compose('**x**', [], 'plain').body).toBe('**x**');
  });

  it('runs the draft pipeline', async () => {
    const pipeline: DraftPipeline = {
      transform: (d) => Promise.resolve({ ...d, text: d.text.toUpperCase() }),
      allowsTyping: () => true,
    };
    const { send, conv, list, history } = await setup({ pipeline });
    const id = conv('orchard-eng');
    await history.open(id);
    await send.send(draft(id, 'quiet'));
    expect(list(id).at(-1)?.body).toBe('QUIET');
  });

  it('edits optimistically and rolls back on failure', async () => {
    const { send, backend, repository, conv, list, history } = await setup();
    const id = conv('dm-ines');
    await history.open(id);
    await send.send(draft(id, 'tpyo'));
    const mine = list(id).at(-1)!;
    expect(await send.edit(id, mine.id, 'typo')).toBe(true);
    expect(list(id).at(-1)).toMatchObject({ body: 'typo', edits: 1 });
    expect(await repository.get(mine.id)).toMatchObject({ body: 'typo', edits: 1 });

    backend.failNext();
    expect(await send.edit(id, mine.id, 'typo again')).toBe(false);
    expect(list(id).at(-1)).toMatchObject({ body: 'typo', edits: 1 });
    expect(await send.edit(id, mine.id, 'typo')).toBe(false);
  });

  it('(B) queues edit/react/delete on a pending message and replays them on the real id', async () => {
    const s = await setup({ latencyMs: 100 });
    const id = s.conv('books');
    await s.history.open(id);
    const p = s.send.send(draft(id, 'hi'));
    await flush();
    const pending = s.list(id).at(-1)!;
    expect(pending.status).toBe('pending');
    // Pending messages are never the target of "↑ to edit".
    expect(messagesSelectors.lastOwn(id, s.selfId)(s.stores.messages.getState())?.id).not.toBe(
      pending.id,
    );

    expect(await s.send.edit(id, pending.id, 'hi edited')).toBe(true);
    expect(await s.send.react(id, s.list(id).at(-1)!, '👍')).toBe(true);
    // Shown immediately, without waiting for the send.
    expect(s.list(id).at(-1)).toMatchObject({ body: 'hi edited', reactions: [{ emoji: '👍' }] });

    for (let i = 0; i < 4; i++) {
      s.scheduler.advance(100);
      await flush();
    }
    await p;
    const mine = s.list(id).at(-1)!;
    const server = s.backend.world.histories.get(id)!.at(-1)!;
    expect(mine).toMatchObject({ id: messageId(s.selfId, NOW + 100), body: 'hi edited' });
    expect(server).toMatchObject({ sentAt: NOW + 100, body: 'hi edited', edits: 1 });
    expect(server.reactions.map((r) => r.emoji)).toEqual(['👍']);
    expect(await s.repository.get(mine.id)).toMatchObject({
      body: 'hi edited',
      reactions: [{ emoji: '👍' }],
    });
    expect(s.onError).not.toHaveBeenCalled();
  });

  it('(B) editing or deleting a failed (never sent) message changes what will be sent', async () => {
    const s = await setup();
    const id = s.conv('books');
    await s.history.open(id);
    s.backend.failNext();
    await s.send.send(draft(id, 'tpyo'));
    const failed = s.list(id).at(-1)!;
    expect(await s.send.edit(id, failed.id, 'typo')).toBe(true);
    await s.send.retry(id, 'nonce-1');
    expect(s.backend.world.histories.get(id)!.at(-1)).toMatchObject({ body: 'typo' });
    expect(s.backend.world.histories.get(id)!.at(-1)?.edits).toBeUndefined();

    s.backend.failNext();
    await s.send.send(draft(id, 'never mind'));
    expect(await s.send.deleteForEveryone(id, s.list(id).at(-1)!)).toBe(true);
    expect(s.stores.messages.getState().findByNonce(id, 'nonce-2')).toBeUndefined();
  });

  it('toggles reactions and keeps concurrent reactions on rollback', async () => {
    const { send, backend, sync, conv, selfId, list, history } = await setup();
    const id = conv('dm-ines');
    await history.open(id);
    await send.send(draft(id, 'react to me'));
    const get = () => list(id).at(-1)!;
    await send.toggleReaction(id, get(), '👍');
    expect(get().reactions.map((r) => [r.authorId, r.emoji])).toEqual([[selfId, '👍']]);
    await send.toggleReaction(id, get(), '👍');
    expect(get().reactions).toEqual([]);

    backend.failNext();
    const pending = send.react(id, get(), '🎯');
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
    const { send, conv, list, history } = await setup();
    const id = conv('dm-ines');
    await history.open(id);
    await send.send(draft(id, 'oops'));
    const mine = list(id).at(-1)!;
    expect(await send.deleteForEveryone(id, mine)).toBe(true);
    expect(list(id).at(-1)).toMatchObject({ deleted: true, body: '' });
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
  it('loads the newest page and backfills older pages from the backend', async () => {
    const { stores, history, backend, conv, list } = await setup();
    const id = conv('crux');
    const full = backend.world.histories.get(id)!;
    await history.open(id);
    expect(list(id).map((m) => m.id)).toEqual(full.slice(-20).map((m) => m.id));
    for (let i = 0; i < 10 && stores.messages.getState().windows[id]?.hasMoreBefore; i++) {
      await history.loadOlder(id);
    }
    expect(list(id).map((m) => m.id)).toEqual(full.map((m) => m.id));
    expect(stores.messages.getState().windows[id]).toMatchObject({
      hasMoreBefore: false,
      loading: false,
    });
  });

  it('jumps to an old message, pages forward, and re-anchors to the present', async () => {
    const { stores, history, backend, sync, conv, list, memberOf } = await setup();
    const id = conv('crux');
    await history.open(id);
    for (let i = 0; i < 3; i++) await history.loadOlder(id);
    const all = list(id);
    const target = all[5]!;

    expect(await history.jumpTo(id, target.id)).toBe(true);
    const w = () => stores.messages.getState().windows[id]!;
    expect(w()).toMatchObject({ anchoredToPresent: false, hasMoreAfter: true });
    expect(list(id).map((m) => m.id)).toContain(target.id);
    // Live messages don't get spliced into a detached window…
    backend.deliver(incoming(id, memberOf(id), NOW + 7));
    await sync.idle();
    expect(list(id).some((m) => m.sentAt === NOW + 7)).toBe(false);
    // …paging forward eventually reaches the present and re-anchors.
    for (let i = 0; i < 10 && !w().anchoredToPresent; i++) await history.loadNewer(id);
    expect(w().anchoredToPresent).toBe(true);
    expect(list(id).at(-1)?.sentAt).toBe(NOW + 7);

    await history.jumpTo(id, target.id);
    await history.jumpToPresent(id);
    expect(w().anchoredToPresent).toBe(true);
    expect(await history.jumpTo(id, messageId('nobody', 1))).toBe(false);
  });

  it('snapshots the unread marker on open, unaffected by later auto-read', async () => {
    const { stores, history, sync, conv } = await setup();
    const id = conv('orchard-eng');
    const cursor = stores.conversations.getState().readCursors[id];
    await history.open(id);
    await sync.markConversationRead(id);
    expect(stores.conversations.getState().readCursors[id]).not.toBe(cursor);
    expect(stores.ui.getState().unreadMarkers[id]).toBe(cursor);
  });

  it('coalesces concurrent loads', async () => {
    const { history, repository, conv } = await setup();
    const id = conv('crux');
    await history.open(id);
    const spy = vi.spyOn(repository, 'page');
    await Promise.all([history.loadOlder(id), history.loadOlder(id)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
