// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage, loadVersioned, MemoryMessageRepository } from '@/core/persistence';
import { settingsSchema, spacesSelectors } from '@/core/stores';
import { createHearth } from './createHearth';
import { deferredRepository } from './deferredRepository';

describe('createHearth with signal-cli', () => {
  it('picks the signal-cli backend from settings and remembers the account', async () => {
    const storage = createMemoryStorage({
      'hearth.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    });
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', []);
    const scheduler = new ManualScheduler(Date.now());
    const hearth = createHearth({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
      clock: scheduler,
      scheduler,
    });
    expect(hearth.backend.kind).toBe('signal-cli');
    await hearth.start();
    await flush();
    expect(hearth.stores.session.getState().self?.id).toBe(SELF_ACI);
    expect(hearth.stores.settings.getState().connection.account).toBe(SELF_ACI);
    hearth.flush();
    expect(loadVersioned(storage, settingsSchema).connection.account).toBe(SELF_ACI);
    // No demo spaces on a real account.
    expect(spacesSelectors.orderedIds(hearth.stores.spaces.getState())).toHaveLength(0);
    await hearth.dispose();
    expect(hearth.stores.session.getState().status).toBe('offline');
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
