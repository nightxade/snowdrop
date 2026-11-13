import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { appendLocalSystemLine } from './localSystemLine';
import { ReadStateService } from './ReadStateService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

const incoming = (conversationId: ConversationId, authorId: string, sentAt: number): Message => ({
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
});

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.capabilities.setFeature('readSync', true);
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
  const schedulePurge = vi.fn();
  const readState = new ReadStateService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    schedulePurge,
    onError,
  });
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    readState,
    onError,
  });
  await sync.start();
  const conv = backend.world.conversationIds.get('crux')!;
  const selfId = backend.world.self.id;
  const peer = backend.world.conversations.get(conv)!.memberIds.find((m) => m !== selfId)!;
  return { scheduler, backend, repository, stores, readState, sync, onError, conv, selfId, peer };
}

describe('ReadStateService', () => {
  it('is the one SyncService marks read through when it is handed one', async () => {
    const { readState, sync, conv } = await setup();
    const spy = vi.spyOn(readState, 'markConversationRead');
    await sync.markConversationRead(conv);
    expect(spy).toHaveBeenCalledWith(conv);
  });

  it('a message of the user’s own from another device moves the read position to it', async () => {
    const { backend, stores, sync, repository, conv, selfId } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, selfId, NOW + 5));
    await sync.idle();
    const stored = await repository.get(messageId(selfId, NOW + 5));
    expect(stored?.seq).toBeDefined();
    expect(stores.conversations.getState().readCursors[conv]).toBe(stored!.seq);
  });

  it('reports a receipt that failed for some recipients through onError', async () => {
    const { backend, stores, sync, readState, onError, conv, peer } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, peer, NOW + 1));
    await sync.idle();
    const failure = new Error('boom');
    vi.spyOn(backend, 'markRead').mockResolvedValue({
      receipt: 'unknown',
      sync: 'unknown',
      failure: { error: failure, failed: 1, of: 2 },
    });
    await readState.markConversationRead(conv);
    await readState.waitForReceipts();
    expect(onError).toHaveBeenCalledWith(failure, 'read receipt failed (1 of 2 recipients)');
  });

  it('stopping waits only briefly on a receipt that hangs', async () => {
    const { backend, stores, sync, readState, scheduler, conv, peer } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, peer, NOW + 1));
    await sync.idle();
    const markRead = vi.spyOn(backend, 'markRead').mockImplementation(() => new Promise(() => {}));
    void readState.markConversationRead(conv);
    await vi.waitFor(() => {
      expect(markRead).toHaveBeenCalled();
    });
    const waited = readState.waitForReceipts();
    scheduler.advance(2_000);
    await waited;
  });
});

describe('appendLocalSystemLine', () => {
  it('stores and shows the line and reads the chat up to it, without making it unread', async () => {
    const { repository, stores, scheduler, conv, selfId } = await setup();
    await appendLocalSystemLine(
      { repository, stores, clock: scheduler },
      { conversationId: conv, authorId: selfId, text: 'You did a thing', tag: 'thing' },
    );
    const last = stores.conversations.getState().lastMessage[conv];
    expect(last?.kind).toBe('system');
    expect(last?.systemText).toBe('You did a thing');
    expect(stores.conversations.getState().readCursors[conv]).toBe(last?.seq);
  });
});
