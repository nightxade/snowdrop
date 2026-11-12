import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { directConversationId, type Conversation } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { ConversationDirectory } from './ConversationDirectory';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const stores = createStores();
  const directory = new ConversationDirectory({
    backend,
    repository: new MemoryMessageRepository(),
    stores,
    clock: scheduler,
  });
  directory.attach({ generation: () => 0 });
  const direct = (peer: string): Conversation => ({
    id: directConversationId(peer),
    kind: 'direct',
    title: peer,
    memberIds: ['self', peer],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: NOW,
  });
  return { backend, stores, directory, direct };
}

describe('ConversationDirectory', () => {
  it('lists an unknown direct conversation only once a real message is confirmed', () => {
    const { stores, directory, direct } = setup();
    const conv = direct('+15550001');
    directory.upsertConversation(conv);
    expect(stores.conversations.getState().byId[conv.id]).toBeUndefined();
    directory.noteReal(conv.id);
    directory.upsertConversation(conv);
    expect(stores.conversations.getState().byId[conv.id]).toBeDefined();
  });

  it('drops a seeded direct conversation with no real message, and keeps a real one', () => {
    const { stores, directory, direct } = setup();
    const stale = direct('+15550002');
    const real = direct('+15550003');
    stores.conversations.getState().upsertMany([stale, real]);
    const dropped = directory.settleSeeded([
      { conv: stale, hasRealMessage: false },
      { conv: real, hasRealMessage: true },
    ]);
    expect(dropped).toEqual([stale.id]);
    expect(stores.conversations.getState().byId[stale.id]).toBeUndefined();
    expect(stores.conversations.getState().byId[real.id]).toBeDefined();
  });

  it('coalesces refreshes requested while one is running into one follow-up', async () => {
    const { backend, directory } = setup();
    const list = vi.spyOn(backend, 'listConversations');
    await Promise.all([
      directory.refreshConversations(),
      directory.refreshConversations(),
      directory.refreshConversations(),
    ]);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
