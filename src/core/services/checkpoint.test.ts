import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { directConversationId, messageId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const acknowledge = vi.fn();
  Object.assign(backend, { acknowledge });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const sync = new SyncService({ backend, repository, stores, clock: scheduler, scheduler });
  return { scheduler, backend, acknowledge, repository, stores, sync };
}

function incoming(backend: MockBackend, sentAt: number, extra: Partial<Message> = {}): Message {
  const [peer] = [...backend.world.contacts.values()].filter((c) => !c.isSelf);
  const author = peer!.id;
  return {
    id: messageId(author, sentAt),
    conversationId: directConversationId(author),
    authorId: author,
    sentAt,
    receivedAt: NOW,
    body: 'hi',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
    ...extra,
  };
}

describe('SyncService checkpoints', () => {
  it('acknowledges a transport position only after the events before it are stored', async () => {
    const { backend, acknowledge, repository, sync } = setup();
    const message = incoming(backend, NOW - 5);
    const stored: boolean[] = [];
    acknowledge.mockImplementation(() => {
      void repository.get(message.id).then((m) => stored.push(m !== undefined));
    });

    // Delivered while the initial sync is still running: parked behind the gate.
    const starting = sync.start();
    backend.emit('message', message);
    backend.emit('checkpoint', { cursor: 'c-1' });
    expect(acknowledge).not.toHaveBeenCalled();
    await starting;
    await sync.idle();
    await flush();
    expect(acknowledge).toHaveBeenCalledWith('c-1');
    expect(stored).toEqual([true]);
    await sync.stop();
  });

  it('never acknowledges events dropped by stop()', async () => {
    const { backend, acknowledge, sync } = setup();
    await sync.start();
    await sync.stop();
    backend.emit('checkpoint', { cursor: 'late' });
    await flush();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

describe('SyncService disappearing-message tombstones', () => {
  it('does not resurrect a purged message on re-delivery', async () => {
    const { backend, repository, scheduler, sync } = setup();
    await sync.start();
    const message = incoming(backend, NOW - 5, { expiresAt: NOW + 1_000 });
    backend.emit('message', message);
    await sync.idle();
    expect(await repository.get(message.id)).toBeDefined();

    scheduler.advance(2_000);
    await sync.purgeExpired();
    expect(await repository.get(message.id)).toBeUndefined();

    // The daemon replays its buffer (e.g. after a reconnect).
    backend.emit('message', { ...message, expiresAt: scheduler.now() + 60_000 });
    await sync.idle();
    expect(await repository.get(message.id)).toBeUndefined();
    await sync.stop();
  });

  it('drops messages that are already due when they arrive', async () => {
    const { backend, repository, sync } = setup();
    await sync.start();
    const message = incoming(backend, NOW - 10_000, { expiresAt: NOW - 1 });
    backend.emit('message', message);
    await sync.idle();
    expect(await repository.get(message.id)).toBeUndefined();
    await sync.stop();
  });
});
