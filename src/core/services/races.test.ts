/**
 * Regression tests for concurrency races found in review round 2
 * (probes H6, H1, C2, L2 and the orphaned-outbox case).
 */
import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, pendingMessageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores, messagesSelectors } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';
import type { OutgoingDraft } from './types';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function setup(
  options: {
    repository?: MemoryMessageRepository;
    latencyMs?: number;
    start?: boolean;
    noServerHistory?: boolean;
  } = {},
) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  if (options.noServerHistory) Object.assign(backend, { fetchHistory: undefined });
  const repository = options.repository ?? new MemoryMessageRepository();
  const stores = createStores();
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

const draft = (conversationId: ConversationId, text: string): OutgoingDraft => ({
  conversationId,
  text,
  mentionIds: [],
  attachments: [],
});

/** Makes the next repository.page() call hang until released. */
function holdNextPage(repository: MemoryMessageRepository): () => void {
  const page = repository.page.bind(repository);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.spyOn(repository, 'page').mockImplementation(async (...args) => {
    const result = await page(...args);
    if (first) {
      first = false;
      await gate;
    }
    return result;
  });
  return release;
}

describe('history loading races', () => {
  it('(H6 / N1) keeps a live message that arrives while the conversation is opening', async () => {
    const repository = new MemoryMessageRepository();
    const s = await setup({ repository });
    s.stores.ui.getState().setWindowFocused(false);
    const id = s.conv('books');
    const release = holdNextPage(repository);
    const opening = s.history.open(id);
    await flush();
    s.backend.emit(
      'message',
      incoming(id, s.memberOf(id), NOW + 5000, { body: 'arrived during open' }),
    );
    await s.sync.idle();
    release();
    await opening;
    expect(s.list(id).at(-1)?.body).toBe('arrived during open');
    expect(s.stores.messages.getState().windows[id]).toMatchObject({
      anchoredToPresent: true,
      hasMoreAfter: false,
    });
  });

  it('(H1 / N2) a jump issued during loadOlder supersedes it instead of being dropped', async () => {
    const repository = new MemoryMessageRepository();
    const s = await setup({ repository });
    const id = s.conv('crux');
    await s.history.open(id);
    const all = await repository.page(id, { limit: 1000 });
    const target = all[0]!;
    const release = holdNextPage(repository);
    const older = s.history.loadOlder(id);
    await flush();
    const jumped = s.history.jumpTo(id, target.id);
    release();
    expect(await jumped).toBe(true);
    await older;
    const w = s.stores.messages.getState().windows[id]!;
    // The superseded loadOlder result didn't overwrite the jump's window.
    expect(target.id in w.byId).toBe(true);
    expect(w).toMatchObject({ anchoredToPresent: false, loading: false });
  });

  it('(N2) jumpToPresent during loadOlder still re-anchors, so a send is visible', async () => {
    const repository = new MemoryMessageRepository();
    const s = await setup({ repository });
    const id = s.conv('crux');
    await s.history.open(id);
    const all = await repository.page(id, { limit: 1000 });
    await s.history.jumpTo(id, all[0]!.id);
    await s.history.loadOlder(id);
    const release = holdNextPage(repository);
    const older = s.history.loadOlder(id);
    await flush();
    const present = s.history.jumpToPresent(id);
    release();
    await Promise.all([older, present]);
    expect(s.stores.messages.getState().windows[id]?.anchoredToPresent).toBe(true);
    await s.send.send(draft(id, 'visible?'));
    expect(s.list(id).at(-1)?.body).toBe('visible?');
  });
});

describe('send races', () => {
  it('(C2 / N4) applies receipts that race the commit of an acknowledged send', async () => {
    for (const when of ['before', 'after'] as const) {
      const repository = new MemoryMessageRepository();
      const s = await setup({ latencyMs: 100, repository });
      const id = s.conv('books');
      await s.history.open(id);
      const commit = repository.commitOutgoing.bind(repository);
      vi.spyOn(repository, 'commitOutgoing').mockImplementation(async (...args) => {
        const receipt = async () => {
          s.backend.emit('receipt', {
            authorId: s.memberOf(id),
            sentAts: [NOW + 100],
            type: 'delivered',
          });
          await s.sync.idle();
        };
        if (when === 'before') await receipt();
        const result = await commit(...args);
        if (when === 'after') await receipt();
        return result;
      });
      const p = s.send.send(draft(id, 'hi'));
      await flush();
      s.scheduler.advance(100);
      await p;
      expect(s.list(id).at(-1)?.status, when).toBe('delivered');
      expect((await repository.get(messageId(s.selfId, NOW + 100)))?.status, when).toBe(
        'delivered',
      );
    }
  });

  it('(N6) rebuilds a visible, retryable row for an orphaned outbox entry', async () => {
    const repository = new MemoryMessageRepository();
    const s = await setup({ repository });
    const id = s.conv('books');
    await s.history.open(id);
    await repository.putOutbox({
      nonce: 'lost',
      input: { conversationId: id, body: 'orphan', ranges: [] },
      createdAt: NOW,
    });
    expect(await s.send.restoreOutbox()).toBe(1);
    expect(await repository.get(pendingMessageId('lost'))).toMatchObject({
      status: 'failed',
      body: 'orphan',
    });
    expect(s.stores.messages.getState().findByNonce(id, 'lost')).toMatchObject({
      status: 'failed',
    });
    await s.send.retry(id, 'lost');
    expect(s.list(id).at(-1)).toMatchObject({ body: 'orphan', status: 'sent' });
    expect(await repository.listOutbox()).toEqual([]);
  });
});

describe('sync start races', () => {
  it('(L2 / N3) replays envelopes delivered during a failed start after the retry succeeds', async () => {
    const s = await setup({ start: false, noServerHistory: true });
    const id = s.conv('books');
    const author = s.memberOf(id);
    const listContacts = s.backend.listContacts.bind(s.backend);
    let fail = true;
    vi.spyOn(s.backend, 'listContacts').mockImplementation(async () => {
      if (fail) {
        fail = false;
        s.backend.deliver(incoming(id, author, NOW + 7000, { body: 'during failed start' }));
        throw new Error('listContacts failed');
      }
      return listContacts();
    });
    await expect(s.sync.start()).rejects.toThrow('listContacts failed');
    s.stores.ui.getState().setWindowFocused(false);
    await s.sync.start();
    await s.sync.idle();
    expect(await s.repository.get(messageId(author, NOW + 7000))).toMatchObject({
      body: 'during failed start',
    });
    expect(s.stores.conversations.getState().unread[id]?.count).toBe(1);
  });
});
