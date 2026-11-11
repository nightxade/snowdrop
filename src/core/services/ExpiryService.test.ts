import { describe, expect, it } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { ExpiryService, type ExpiryHost } from './ExpiryService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

function setup(connected: boolean) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const expiry = new ExpiryService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    purgeIntervalMs: 1_000,
  });
  let running: Promise<void> = Promise.resolve();
  const queued: string[] = [];
  const announced: string[] = [];
  const host: ExpiryHost = {
    isConnected: () => connected,
    generation: () => 0,
    runQueued: (name, task) => {
      queued.push(name);
      running = task();
    },
    announceRemoved: (m) => announced.push(m.id),
  };
  expiry.attach(host);
  const conv = backend.world.conversationIds.get('crux')!;
  const authorId = backend.world.self.id;
  const message = (sentAt: number, expiresAt: number): Message => ({
    id: messageId(authorId, sentAt),
    conversationId: conv,
    authorId,
    sentAt,
    receivedAt: NOW,
    body: 'hi',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'normal',
    expiresAt,
  });
  return { settle: () => running, scheduler, repository, expiry, queued, announced, message };
}

describe('ExpiryService', () => {
  it('purges an expired message on its schedule, tombstones it and announces it', async () => {
    const { scheduler, repository, expiry, queued, announced, message, settle } = setup(true);
    const m = message(NOW, NOW + 5_000);
    await repository.upsert(m, (a) => a);
    expiry.noteExpiry(m.expiresAt!);
    scheduler.advance(5_000);
    await settle();
    expect(queued).toEqual(['purge']);
    expect(await repository.get(m.id)).toBeUndefined();
    expect(expiry.hasPurged(m.id)).toBe(true);
    expect(announced).toEqual([m.id]);
    expiry.teardown();
  });

  it('schedules nothing while the engine is not connected', async () => {
    const { scheduler, repository, expiry, queued, message } = setup(false);
    await repository.upsert(message(NOW, NOW + 1_000), (a) => a);
    expiry.schedulePurge(1_000);
    scheduler.advance(60_000);
    expect(queued).toEqual([]);
  });

  it('stops purging after teardown', () => {
    const { scheduler, expiry, queued } = setup(true);
    expiry.schedulePurge(1_000);
    expiry.teardown();
    scheduler.advance(60_000);
    expect(queued).toEqual([]);
  });

  it('keeps the tombstone set bounded, evicting the oldest', () => {
    const { expiry } = setup(true);
    const ids = Array.from({ length: 2_001 }, (_, i) => messageId('a', i));
    for (const id of ids) expiry.rememberPurged(id);
    expect(expiry.hasPurged(ids[0]!)).toBe(false);
    expect(expiry.hasPurged(ids[2_000]!)).toBe(true);
  });
});
