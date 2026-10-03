/** Disappearing-message timer and group rename go through SendService to the transport (P6). */
import { afterEach, describe, expect, it } from 'vitest';
import { createShrike, type Shrike } from '@/app';
import { createMemoryStorage } from '@/core/persistence';

const live: Shrike[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.dispose();
});

async function boot(): Promise<Shrike> {
  const shrike = createShrike({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(shrike);
  shrike.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await shrike.start();
  await shrike.sync.idle();
  return shrike;
}

describe('conversation settings', () => {
  it('sets the timer for everyone and shows the system line', async () => {
    const shrike = await boot();
    expect(shrike.send.capabilities.updateConversation).toBe(true);
    const conv = Object.values(shrike.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct',
    )!;
    const ok = await shrike.send.updateConversation(conv.id, { expireTimerSec: 3600 });
    await shrike.sync.idle();
    expect(ok).toBe(true);
    expect(shrike.stores.conversations.getState().byId[conv.id]?.expireTimerSec).toBe(3600);
    const latest = await shrike.repository.latest(conv.id);
    expect(latest?.kind).toBe('system');
    expect(latest?.systemText).toBe('You set disappearing messages to 1 hour.');
  });

  it('renames a group', async () => {
    const shrike = await boot();
    const group = Object.values(shrike.stores.conversations.getState().byId).find(
      (c) => c.kind === 'group',
    )!;
    expect(await shrike.send.updateConversation(group.id, { title: 'Renamed crew' })).toBe(true);
    await shrike.sync.idle();
    expect(shrike.stores.conversations.getState().byId[group.id]?.title).toBe('Renamed crew');
  });
});
