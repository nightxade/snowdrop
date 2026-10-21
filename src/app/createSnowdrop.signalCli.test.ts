// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { conversationIdFor } from '@/core/domain/testing';
import { ManualScheduler } from '@/core/lib';
import {
  createMemoryStorage,
  loadVersioned,
  MemoryMessageRepository,
  saveVersioned,
} from '@/core/persistence';
import { localSchema, settingsSchema, spacesSchema, spacesSelectors } from '@/core/stores';
import { startOnce } from './App';
import { createSnowdrop } from './createSnowdrop';
import { scopedKey, scopedSchema } from './dataScope';
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

  it('logs "no account yet" once, at info, not three times (sync, App effect, startOnce)', async () => {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    });
    // No accounts at all: SignalCliBackend.chooseAccount throws 'no-account',
    // the same expected first-run state as the real user log this fixes.
    const daemon = new FakeDaemon().reply('listAccounts', []);
    const snowdrop = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Exercises the exact three spots the real app funnels this failure
    // through: SyncService (inside start()), and startOnce's own catch
    // (which stands in for App.tsx's effect + its startOnce catch).
    startOnce(snowdrop);
    await flush();

    expect(snowdrop.stores.session.getState().errorKind).toBe('no-account');
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(String(consoleInfo.mock.calls[0]?.[0])).toMatch(/no linked account yet/u);
    expect(consoleError).not.toHaveBeenCalled();

    consoleInfo.mockRestore();
    consoleError.mockRestore();
    await snowdrop.dispose();
  });

  it('logs a real connect failure once, at error, including when retried through startOnce', async () => {
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    });
    // The daemon is down (every fetch rejects): 'unreachable', a real
    // failure, not an expected setup state like 'no-account' or
    // 'account-required'.
    const daemon = new FakeDaemon();
    daemon.up = false;
    const snowdrop = createSnowdrop({
      storage,
      fetch: daemon.fetch,
      repository: new MemoryMessageRepository(),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    startOnce(snowdrop);
    await flush();

    expect(snowdrop.stores.session.getState().status).toBe('error');
    // Exactly one error line for this failure, not triplicated across
    // SyncService, App.tsx's effect and startOnce's own catch.
    expect(consoleError).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
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

  it('sign-out clears the account’s local data and keeps settings, spaces and other accounts', async () => {
    const other = '99999999-1111-2222-3333-444455556666';
    const scope = `signal-cli:${SELF_ACI}`;
    const storage = createMemoryStorage({
      'snowdrop.settings': JSON.stringify({
        v: 2,
        data: {
          connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: SELF_ACI },
        },
      }),
      [`snowdrop.signal-cli.peers.${SELF_ACI}`]: '{"peers":{},"aliases":{}}',
      [`snowdrop.signal-cli.cursor.tauri.${SELF_ACI}`]: '42',
      [`snowdrop.signal-cli.peers.${other}`]: '{"peers":{},"aliases":{}}',
      [scopedKey(localSchema.key, `signal-cli:${other}`)]: 'other account local',
    });
    saveVersioned(storage, scopedSchema(spacesSchema, scope), spacesSchema.defaults());
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
    snowdrop.stores.local.getState().setNote('someone', 'a private note');
    snowdrop.stores.local.getState().setPinned(conversationIdFor('someone'), true);
    snowdrop.flush();
    const localKey = scopedSchema(localSchema, scope).key;
    expect(storage.getItem(localKey)).toContain('a private note');
    const spacesKey = scopedSchema(spacesSchema, scope).key;
    expect(storage.getItem(spacesKey)).not.toBeNull();

    await snowdrop.admin.disconnect();
    await snowdrop.admin.clearAccountData();

    expect(storage.getItem(localKey)).toBeNull();
    expect(storage.getItem(`snowdrop.signal-cli.peers.${SELF_ACI}`)).toBeNull();
    expect(storage.getItem(`snowdrop.signal-cli.cursor.tauri.${SELF_ACI}`)).toBeNull();
    // Kept: settings, spaces, and another account's data.
    expect(storage.getItem(settingsSchema.key)).not.toBeNull();
    expect(storage.getItem(spacesKey)).not.toBeNull();
    expect(storage.getItem(`snowdrop.signal-cli.peers.${other}`)).not.toBeNull();
    expect(storage.getItem(scopedKey(localSchema.key, `signal-cli:${other}`))).not.toBeNull();

    // Nothing writes the cleared state back (a flush, a late edit, a dispose).
    snowdrop.stores.local.getState().setNote('someone', 'edited after sign-out');
    snowdrop.flush();
    await snowdrop.dispose();
    expect(storage.getItem(localKey)).toBeNull();
  });
});
