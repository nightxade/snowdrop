// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage, loadVersioned, MemoryMessageRepository } from '@/core/persistence';
import { settingsSchema, spacesSchema, spacesSelectors } from '@/core/stores';
import { createSnowdrop } from './createSnowdrop';
import { scopedSchema } from './dataScope';
import { deferredRepository } from './deferredRepository';

describe('createSnowdrop with signal-cli', () => {
  it('picks the signal-cli backend from settings and remembers the account', async () => {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    });
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', []);
    const scheduler = new ManualScheduler(Date.now());
    const snowdrop = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
      clock: scheduler,
      scheduler,
    });
    expect(snowdrop.backend.kind).toBe('signal-cli');
    await snowdrop.start();
    await flush();
    expect(snowdrop.stores.session.getState().self?.id).toBe(SELF_ACI);
    expect(snowdrop.stores.settings.getState().connection.account).toBe(SELF_ACI);
    snowdrop.flush();
    expect(loadVersioned(storage, settingsSchema).connection.account).toBe(SELF_ACI);
    // No demo spaces on a real account: the demo's own scope (src/app/
    // dataScope.ts) never leaks into this account's.
    expect(spacesSelectors.orderedIds(snowdrop.stores.spaces.getState())).toHaveLength(0);
    expect(storage.getItem(scopedSchema(spacesSchema, 'demo').key)).toBeNull();
    // Persisted under the account's own scope, not the pending placeholder.
    expect(
      storage.getItem(scopedSchema(spacesSchema, `signal-cli:${SELF_ACI}`).key),
    ).not.toBeNull();
    expect(storage.getItem(scopedSchema(spacesSchema, 'signal-cli:pending').key)).toBeNull();
    await snowdrop.dispose();
    expect(snowdrop.stores.session.getState().status).toBe('offline');
  });

  it('never shows the demo’s seeded spaces under a signal-cli scope', async () => {
    const storage = createMemoryStorage();
    // Try the demo first — it seeds its own example spaces.
    const demo = createSnowdrop({ storage, mockLatencyMs: 0 });
    await demo.start();
    expect(spacesSelectors.orderedIds(demo.stores.spaces.getState())).toHaveLength(3);
    await demo.dispose();

    // Then connect a real signal-cli account on the same device/storage.
    storage.setItem(
      settingsSchema.key,
      JSON.stringify({
        v: settingsSchema.version,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    );
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', []);
    const snowdrop = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    await snowdrop.start();
    await flush();
    expect(spacesSelectors.orderedIds(snowdrop.stores.spaces.getState())).toHaveLength(0);
    await snowdrop.dispose();

    // Switching back to the demo restores its own spaces, untouched.
    storage.setItem(
      settingsSchema.key,
      JSON.stringify({ v: settingsSchema.version, data: { connection: { backend: 'mock' } } }),
    );
    const again = createSnowdrop({ storage, mockLatencyMs: 0 });
    await again.start();
    expect(spacesSelectors.orderedIds(again.stores.spaces.getState())).toHaveLength(3);
    await again.dispose();
  });

  it('rebinds to the account discovered at runtime without losing what happened before that', async () => {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    });
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', []);
    const snowdrop = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    // The account is not known yet — this happens under the pending
    // placeholder scope, before `start()` discovers it.
    const pendingSpace = snowdrop.stores.spaces.getState().createSpace({ name: 'Before linking' });
    snowdrop.stores.local.getState().setNote('contact-1', 'a note made before linking');

    await snowdrop.start();
    await flush();
    snowdrop.flush();

    // Rebound to the discovered account: nothing from the pending window was lost.
    expect(snowdrop.stores.spaces.getState().spaces[pendingSpace]?.name).toBe('Before linking');
    expect(snowdrop.stores.local.getState().contactNotes['contact-1']).toBe(
      'a note made before linking',
    );
    const accountScope = scopedSchema(spacesSchema, `signal-cli:${SELF_ACI}`);
    expect(Object.values(loadVersioned(storage, accountScope).spaces).map((s) => s.name)).toContain(
      'Before linking',
    );
    // The pending placeholder's key is cleaned up, not left as stale data.
    expect(storage.getItem(scopedSchema(spacesSchema, 'signal-cli:pending').key)).toBeNull();

    await snowdrop.dispose();
  });
});

describe('deferredRepository', () => {
  it('forwards calls once the real repository is ready, and is not thenable', async () => {
    let open: (r: MemoryMessageRepository) => void = () => undefined;
    const repo = deferredRepository(new Promise((resolve) => (open = resolve)));
    const pending = repo.count('dm:x' as never);
    expect((repo as unknown as { then?: unknown }).then).toBeUndefined();
    open(new MemoryMessageRepository());
    expect(await pending).toBe(0);
  });

  it('rejects every call when opening failed', async () => {
    const repo = deferredRepository(Promise.reject(new Error('blocked')));
    await expect(repo.getReadCursors()).rejects.toThrow('blocked');
  });
});
