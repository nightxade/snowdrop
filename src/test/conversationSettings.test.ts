/** Disappearing-message timer and group rename go through SendService to the transport (P6). */
import { afterEach, describe, expect, it } from 'vitest';
import { createSnowdrop, type Snowdrop } from '@/app';
import { createMemoryStorage } from '@/core/persistence';

const live: Snowdrop[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.dispose();
});

async function boot(): Promise<Snowdrop> {
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(snowdrop);
  snowdrop.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await snowdrop.start();
  await snowdrop.sync.idle();
  return snowdrop;
}

describe('conversation settings', () => {
  it('sets the timer for everyone and shows the system line', async () => {
    const snowdrop = await boot();
    expect(snowdrop.send.capabilities.updateConversation).toBe(true);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct',
    )!;
    const ok = await snowdrop.send.updateConversation(conv.id, { expireTimerSec: 3600 });
    await snowdrop.sync.idle();
    expect(ok).toBe(true);
    expect(snowdrop.stores.conversations.getState().byId[conv.id]?.expireTimerSec).toBe(3600);
    const latest = await snowdrop.repository.latest(conv.id);
    expect(latest?.kind).toBe('system');
    expect(latest?.systemText).toBe('You set disappearing messages to 1 hour.');
  });

  it('renames a group', async () => {
    const snowdrop = await boot();
    const group = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'group',
    )!;
    expect(await snowdrop.send.updateConversation(group.id, { title: 'Renamed crew' })).toBe(true);
    await snowdrop.sync.idle();
    expect(snowdrop.stores.conversations.getState().byId[group.id]?.title).toBe('Renamed crew');
  });
});
