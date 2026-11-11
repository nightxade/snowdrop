import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

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
  body: `message ${sentAt - NOW}`,
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
  ...extra,
});

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.capabilities.setFeature('readSync', true);
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
  const send = new SendService({ backend, repository, stores, clock: scheduler, onError });
  const conv = backend.world.conversationIds.get('crux')!;
  const other = backend.world.conversationIds.get('request-dm')!;
  const selfId = backend.world.self.id;
  const peerOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  return { backend, scheduler, repository, stores, sync, send, onError, conv, other, peerOf };
}

/** Lets pending promise chains run without waiting on anything that never settles. */
async function turns(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** True if `promise` settles within a few turns. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await turns(5);
  return done;
}

describe('read receipts never hold the event queue', () => {
  it('applies later events while a read receipt is still in flight', async () => {
    const { backend, stores, sync, repository, conv, other, peerOf } = await setup();
    await sync.markConversationRead(conv);
    vi.spyOn(backend, 'markRead').mockImplementation(() => new Promise(() => undefined));
    stores.ui.getState().setWindowFocused(true);
    stores.ui.getState().selectConversation(conv);
    const arrived: number[] = [];
    sync.on('messageArrived', ({ message }) => arrived.push(message.sentAt));
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    backend.deliver(incoming(other, peerOf(other), NOW + 2));
    backend.deliver(incoming(conv, peerOf(conv), NOW + 3));
    expect(await settles(sync.idle())).toBe(true);
    expect(arrived).toEqual([NOW + 1, NOW + 2, NOW + 3]);
    // Stored and read locally even though no receipt has gone out.
    expect(await repository.get(messageId(peerOf(conv), NOW + 3))).toBeDefined();
    expect(stores.conversations.getState().unread[conv]?.count ?? 0).toBe(0);
  });

  it('still sends the receipts, in order, one at a time', async () => {
    const { backend, stores, sync, conv, peerOf } = await setup();
    await sync.markConversationRead(conv);
    const releases: (() => void)[] = [];
    const markRead = vi.spyOn(backend, 'markRead').mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve({ receipt: 'success', sync: 'success' });
          });
        }),
    );
    stores.ui.getState().setWindowFocused(true);
    stores.ui.getState().selectConversation(conv);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    backend.deliver(incoming(conv, peerOf(conv), NOW + 2));
    await sync.idle();
    await turns();
    expect(markRead).toHaveBeenCalledTimes(1);
    releases[0]!();
    await turns();
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls.map((c) => c[1])).toEqual([
      [{ authorId: peerOf(conv), sentAt: NOW + 1 }],
      [{ authorId: peerOf(conv), sentAt: NOW + 2 }],
    ]);
    releases[1]!();
  });
});

describe('unread count while reading', () => {
  it('leaves a message that arrived during the read unread', async () => {
    const { backend, stores, sync, repository, conv, peerOf } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    backend.deliver(incoming(conv, peerOf(conv), NOW + 2));
    await sync.idle();
    const before = stores.conversations.getState().unread[conv]!.count;
    expect(before).toBeGreaterThanOrEqual(2);
    // A third message is stored between the read's snapshot and its write.
    const real = repository.listAfter.bind(repository);
    let injected = false;
    vi.spyOn(repository, 'listAfter').mockImplementation(async (...args) => {
      const snapshot = await real(...args);
      if (!injected) {
        injected = true;
        backend.deliver(incoming(conv, peerOf(conv), NOW + 3));
        await sync.idle();
      }
      return snapshot;
    });
    await sync.markConversationRead(conv);
    expect(stores.conversations.getState().unread[conv]?.count).toBe(1);
    // The cursor stops at what was read, so the newer one is still unread by position too.
    const newest = await repository.get(messageId(peerOf(conv), NOW + 3));
    expect(stores.conversations.getState().readCursors[conv]).toBeLessThan(newest!.seq!);
  });
});

describe('the sidebar preview follows the messages that remain', () => {
  const previewId = (stores: ReturnType<typeof createStores>, conv: ConversationId) =>
    stores.conversations.getState().lastMessage[conv]?.id;

  it('falls back when the newest message expires', async () => {
    const { backend, scheduler, stores, sync, conv, peerOf } = await setup();
    const peer = peerOf(conv);
    backend.deliver(incoming(conv, peer, NOW + 1));
    backend.deliver(incoming(conv, peer, NOW + 2, { expiresAt: NOW + 60_000 }));
    await sync.idle();
    expect(previewId(stores, conv)).toBe(messageId(peer, NOW + 2));
    scheduler.advance(61_000);
    await sync.idle();
    expect(previewId(stores, conv)).toBe(messageId(peer, NOW + 1));
  });

  it('falls back, then empties, as the newest messages are deleted for me', async () => {
    const { backend, stores, sync, send, repository, conv, peerOf } = await setup();
    const peer = peerOf(conv);
    backend.deliver(incoming(conv, peer, NOW + 1));
    backend.deliver(incoming(conv, peer, NOW + 2));
    await sync.idle();
    for (;;) {
      const all = await repository.listAfter(conv, 0);
      const newest = all.at(-1);
      if (!newest) break;
      await send.deleteForMe(conv, newest);
      const next = all.at(-2);
      expect(previewId(stores, conv)).toBe(next?.id);
    }
    expect(stores.conversations.getState().lastMessage[conv]).toBeUndefined();
  });

  it('leaves the preview alone when a message other than the newest goes', async () => {
    const { backend, stores, sync, send, repository, conv, peerOf } = await setup();
    const peer = peerOf(conv);
    backend.deliver(incoming(conv, peer, NOW + 1));
    backend.deliver(incoming(conv, peer, NOW + 2));
    await sync.idle();
    await send.deleteForMe(conv, (await repository.get(messageId(peer, NOW + 1)))!);
    expect(previewId(stores, conv)).toBe(messageId(peer, NOW + 2));
  });
});

describe('the catch-up quiet period follows processing', () => {
  it('keeps holding notifications while the queue is still working through the backlog', async () => {
    const { backend, scheduler, repository, stores, sync, conv, peerOf } = await setup();
    backend.capabilities.setFeature('catchingUpSignal', false);
    // A catch-up with the quiet-period fallback (no caughtUp promised).
    backend.emit('catchingUp', undefined);
    expect(stores.session.getState().notificationsHeld).toBe(true);
    const arrivals: boolean[] = [];
    sync.on('messageArrived', () => arrivals.push(stores.session.getState().notificationsHeld));
    // Each message takes one simulated second to store, one after the other.
    const gates: (() => void)[] = [];
    const realUpsert = repository.upsert.bind(repository);
    vi.spyOn(repository, 'upsert').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return realUpsert(...args);
    });
    for (let i = 1; i <= 3; i++) backend.deliver(incoming(conv, peerOf(conv), NOW + i));
    for (let i = 0; i < 3; i++) {
      await turns();
      scheduler.advance(1_000);
      gates[i]!();
    }
    await sync.idle();
    expect(arrivals).toEqual([true, true, true]);
    scheduler.advance(1_500);
    expect(stores.session.getState().notificationsHeld).toBe(false);
  });
});

describe('read receipts and shutdown', () => {
  async function viewingWithPendingReceipt() {
    const ctx = await setup();
    const { backend, stores, sync, conv, peerOf } = ctx;
    await sync.markConversationRead(conv);
    let settle: { resolve: () => void; reject: (e: Error) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    vi.spyOn(backend, 'markRead').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = {
            resolve: () => {
              resolve({ receipt: 'success', sync: 'success' });
            },
            reject: (e) => {
              reject(e);
            },
          };
        }),
    );
    stores.ui.getState().setWindowFocused(true);
    stores.ui.getState().selectConversation(conv);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    await sync.idle();
    await turns();
    return { ...ctx, settle: () => settle };
  }

  it('stop() waits for a receipt in flight, but only briefly for a hung one', async () => {
    const { sync, scheduler, settle } = await viewingWithPendingReceipt();
    let stopped = false;
    const stopping = sync.stop().then(() => {
      stopped = true;
    });
    await turns();
    expect(stopped).toBe(false);
    settle().resolve();
    await stopping;
    expect(stopped).toBe(true);
    // A hung one is given up on after the wait.
    const again = await viewingWithPendingReceipt();
    let gaveUp = false;
    const stoppingAgain = again.sync.stop().then(() => {
      gaveUp = true;
    });
    await turns();
    expect(gaveUp).toBe(false);
    again.scheduler.advance(2_000);
    await stoppingAgain;
    expect(gaveUp).toBe(true);
    expect(scheduler).toBeDefined();
  });

  it('drops a receipt that fails after shutdown without reporting it', async () => {
    const { sync, scheduler, settle, onError } = await viewingWithPendingReceipt();
    const stopping = sync.stop();
    await turns();
    scheduler.advance(2_000);
    await stopping;
    settle().reject(new Error('connection closed'));
    await turns();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('contacts that arrive around the initial sync', () => {
  it('keeps the newest contact and the real own profile over an older listing', async () => {
    const scheduler = new ManualScheduler(NOW);
    const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
    const stores = createStores();
    const sync = new SyncService({
      backend,
      repository: new MemoryMessageRepository(),
      stores,
      clock: scheduler,
      scheduler,
      onError: vi.fn(),
    });
    const placeholder = await backend.getSelf();
    const friend = (await backend.listContacts())[0]!;
    // The listing the sync is about to store is older than what arrives meanwhile.
    vi.spyOn(backend, 'getSelf').mockImplementation(() => {
      const early = { ...placeholder, name: 'You' };
      backend.emit('contactUpdated', { ...placeholder, name: 'Real Self' });
      backend.emit('contactUpdated', { ...friend, name: 'Fresh Friend' });
      return Promise.resolve(early);
    });
    await sync.start();
    expect(stores.session.getState().self).toMatchObject({ id: placeholder.id, name: 'Real Self' });
    expect(stores.contacts.getState().byId[friend.id]?.name).toBe('Fresh Friend');
    await sync.stop();
  });
});
