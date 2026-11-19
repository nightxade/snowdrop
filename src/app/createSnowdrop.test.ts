import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import {
  APPEARANCE_BOOT_KEY,
  createMemoryStorage,
  loadVersioned,
  saveVersioned,
} from '@/core/persistence';
import { localSchema, settingsSchema, spacesSchema, spacesSelectors } from '@/core/stores';
import { STYLE_IDS } from '@/core/themes';
import type { MockBackend } from '@/core/backend/mock';
import { createSnowdrop, type Snowdrop } from './createSnowdrop';
import { scopedSchema } from './dataScope';

/** The demo's own scope (src/app/dataScope.ts); every test here runs on the mock backend. */
const demoSpaces = scopedSchema(spacesSchema, 'demo');
const demoLocal = scopedSchema(localSchema, 'demo');

const NOW = Date.UTC(2026, 8, 30, 15, 30);

describe('createSnowdrop', () => {
  it('wires backend, sync, stores, plugins and themes together', async () => {
    const scheduler = new ManualScheduler(NOW);
    const storage = createMemoryStorage();
    const snowdrop = createSnowdrop({
      storage,
      document,
      clock: scheduler,
      scheduler,
      mockLatencyMs: 0,
    });
    await snowdrop.start();

    const { stores } = snowdrop;
    expect(stores.session.getState().phase).toBe('ready');
    expect(Object.keys(stores.conversations.getState().byId)).toHaveLength(24);
    // Default spaces were seeded and persisted, under the demo's own scope
    // (src/app/dataScope.ts) — never the bare, unscoped key.
    expect(spacesSelectors.orderedIds(stores.spaces.getState())).toHaveLength(3);
    expect(Object.keys(loadVersioned(storage, demoSpaces).spaces)).toHaveLength(3);
    expect(storage.getItem(spacesSchema.key)).toBeNull();
    // Default-on plugins are running and feed the send pipeline.
    expect(snowdrop.plugins.get('clear-urls')?.status).toBe('running');
    expect(snowdrop.registries.findSlash('shrug')).toBeDefined();
    // Theme applied, and it follows settings.
    expect(document.getElementById(STYLE_IDS.theme)).not.toBeNull();
    stores.settings.getState().update('appearance', { themeId: 'linen' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('linen');
    expect(loadVersioned(storage, settingsSchema).appearance.themeId).toBe('linen');

    // The TUI shell sets data-shell and is mirrored (plaintext) for the
    // pre-unlock boot screens to pick up with no flash of the standard shell.
    stores.settings.getState().update('appearance', { shell: 'tui' });
    expect(document.documentElement.getAttribute('data-shell')).toBe('tui');
    expect(JSON.parse(storage.getItem(APPEARANCE_BOOT_KEY) ?? '{}')).toMatchObject({
      shell: 'tui',
    });
    stores.settings.getState().update('appearance', { shell: 'standard' });
    expect(document.documentElement.hasAttribute('data-shell')).toBe(false);
    // The palette command toggles it, same as the Appearance → Layout control.
    await snowdrop.commands.execute('core.toggleTuiShell');
    expect(stores.settings.getState().appearance.shell).toBe('tui');
    await snowdrop.commands.execute('core.toggleTuiShell');
    expect(stores.settings.getState().appearance.shell).toBe('standard');

    // Liveliness runs on the injected scheduler.
    const before = Object.values(stores.conversations.getState().byId).reduce(
      (n, c) => Math.max(n, c.lastActivityAt),
      0,
    );
    scheduler.advance(60_000);
    await snowdrop.sync.idle();
    const after = Object.values(stores.conversations.getState().byId).reduce(
      (n, c) => Math.max(n, c.lastActivityAt),
      0,
    );
    expect(after).toBeGreaterThan(before);

    // Commands drive the UI store.
    await snowdrop.commands.execute('core.toggleMemberList');
    expect(stores.ui.getState().memberListOpen).toBe(false);

    await snowdrop.dispose();
    expect(stores.session.getState().link).toBe('offline');
  });

  describe('a send refused over a changed safety number', () => {
    /** Annika's chat is open and a message to her is going out, taking 100 ms. */
    async function sendingToAnnika() {
      const scheduler = new ManualScheduler(NOW);
      const snowdrop = createSnowdrop({
        storage: createMemoryStorage(),
        clock: scheduler,
        scheduler,
        mockLatencyMs: 0,
      });
      await snowdrop.start();
      const mock = (await snowdrop.backendReady) as MockBackend;
      Object.assign(mock, { latencyMs: 100 });
      const id = mock.world.conversationIds.get('dm-annika')!;
      snowdrop.stores.ui.getState().selectConversation(id, 'home');
      const sending = snowdrop.send.send({
        conversationId: id,
        text: 'hi',
        mentionIds: [],
        attachments: [],
      });
      await snowdrop.sync.idle();
      return { snowdrop, scheduler, sending, id };
    }
    /** Lets the send run to its end: every wait the demo makes (each takes 100 ms) is advanced. */
    const finish = async (scheduler: ManualScheduler, sending: Promise<unknown>) => {
      const state = { done: false };
      void sending.then(() => {
        state.done = true;
      });
      for (let i = 0; i < 10 && !state.done; i++) {
        scheduler.advance(100);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await sending;
    };
    const modal = (s: Snowdrop) => s.stores.ui.getState().modal;

    it('opens the review dialog when the user has done nothing since', async () => {
      const { snowdrop, scheduler, sending, id } = await sendingToAnnika();
      await finish(scheduler, sending);
      expect(modal(snowdrop)).toMatchObject({
        type: 'safetyNumberChange',
        props: { conversationId: id },
      });
      await snowdrop.dispose();
    });

    it('does not open it over a user who pressed a key meanwhile', async () => {
      const { snowdrop, scheduler, sending } = await sendingToAnnika();
      scheduler.advance(1);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await finish(scheduler, sending);
      expect(modal(snowdrop)).toBeNull();
      await snowdrop.dispose();
    });

    it('does not open it over a pointer press either', async () => {
      const { snowdrop, scheduler, sending } = await sendingToAnnika();
      scheduler.advance(1);
      window.dispatchEvent(new Event('pointerdown'));
      await finish(scheduler, sending);
      expect(modal(snowdrop)).toBeNull();
      await snowdrop.dispose();
    });
  });

  it('does not re-seed spaces the user deleted', async () => {
    const storage = createMemoryStorage();
    const first = createSnowdrop({ storage, mockLatencyMs: 0 });
    await first.start();
    for (const id of spacesSelectors.orderedIds(first.stores.spaces.getState()))
      first.stores.spaces.getState().deleteSpace(id);
    await first.dispose();

    const second = createSnowdrop({ storage, mockLatencyMs: 0 });
    await second.start();
    expect(spacesSelectors.orderedIds(second.stores.spaces.getState())).toHaveLength(0);
    await second.dispose();
  });

  it('migrates legacy (pre-scoping) unseeded data to the active scope, once', async () => {
    const storage = createMemoryStorage();
    saveVersioned(storage, spacesSchema, {
      spaces: {},
      rail: [],
      homeCollapsed: { conversations: false, direct: false, groups: false },
      seeded: false,
    });
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    // The legacy key is gone immediately (migrated at construction, before start()).
    expect(storage.getItem(spacesSchema.key)).toBeNull();
    await snowdrop.start();
    // The demo still seeds on top of (not instead of) the migrated data.
    expect(spacesSelectors.orderedIds(snowdrop.stores.spaces.getState())).toHaveLength(3);
    await snowdrop.dispose();

    // A second boot does not try to migrate again (no legacy key left).
    const again = createSnowdrop({ storage, mockLatencyMs: 0 });
    await again.start();
    expect(spacesSelectors.orderedIds(again.stores.spaces.getState())).toHaveLength(3);
    await again.dispose();
  });

  it('migrates legacy seeded data to the demo scope even if a different backend is active', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      settingsSchema.key,
      JSON.stringify({
        v: settingsSchema.version,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: 'acc1' } },
      }),
    );
    saveVersioned(storage, spacesSchema, {
      spaces: {},
      rail: [],
      homeCollapsed: { conversations: false, direct: false, groups: false },
      seeded: true,
    });
    createSnowdrop({ storage, mockLatencyMs: 0 });
    expect(storage.getItem(spacesSchema.key)).toBeNull();
    expect(loadVersioned(storage, demoSpaces).seeded).toBe(true);
    expect(storage.getItem(scopedSchema(spacesSchema, 'signal-cli:acc1').key)).toBeNull();
  });

  it('keeps running when a plugin fails', async () => {
    const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await snowdrop.start();
    snowdrop.registries.sendTransforms.add({
      owner: 'evil',
      transform: () => {
        throw new Error('x');
      },
    });
    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!.id;
    await snowdrop.send.send({
      conversationId: conv,
      text: 'still works',
      mentionIds: [],
      attachments: [],
    });
    expect(error).toHaveBeenCalled();
    await snowdrop.dispose();
  });

  it('admin.stopPersistence flushes pending writes, then nothing writes again', async () => {
    const storage = createMemoryStorage();
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    await snowdrop.start();

    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!.id;
    // Drafts are debounced (app/createSnowdrop.ts's `local` binding): this
    // write is still pending until a flush.
    snowdrop.stores.local.getState().setDraft(conv, 'unsaved draft');

    snowdrop.admin.stopPersistence();
    const afterStop = storage.getItem(demoLocal.key);
    expect(afterStop).toContain('unsaved draft'); // flushed, not dropped

    // A later change must not reach storage: persistence is stopped, not just flushed once.
    snowdrop.stores.local.getState().setDraft(conv, 'should never be saved');
    snowdrop.admin.flush();
    expect(storage.getItem(demoLocal.key)).toBe(afterStop);

    await snowdrop.dispose();
  });
});

describe('admin.reload', () => {
  it('waits for an asynchronously persisting store before reloading', async () => {
    const order: string[] = [];
    const storage = Object.assign(createMemoryStorage(), {
      flush: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push('flushed');
            resolve();
          }, 10);
        }),
    });
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    const reload = vi.fn(() => order.push('reloaded'));
    vi.stubGlobal('location', { reload });
    try {
      await snowdrop.admin.reload();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(order).toEqual(['flushed', 'reloaded']);
  });
});

describe('start() and a pending history clear (sign-out fallback)', () => {
  const PENDING_KEY = 'snowdrop.pendingHistoryClear';

  it('clears history before connecting when the flag is set, then clears the flag', async () => {
    const storage = createMemoryStorage();
    storage.setItem(PENDING_KEY, '1');
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    const clearHistory = vi.spyOn(snowdrop.admin, 'clearHistory');
    await snowdrop.start();
    expect(clearHistory).toHaveBeenCalledTimes(1);
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    await snowdrop.dispose();
  });

  it('leaves the flag set, and keeps booting, if the retry fails too', async () => {
    const storage = createMemoryStorage();
    storage.setItem(PENDING_KEY, '1');
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(snowdrop.admin, 'clearHistory').mockRejectedValueOnce(new Error('boom'));
    await snowdrop.start();
    expect(storage.getItem(PENDING_KEY)).toBe('1');
    expect(error).toHaveBeenCalled();
    expect(snowdrop.stores.session.getState().phase).toBe('ready');
    await snowdrop.dispose();
  });

  it('does nothing extra when no flag was left behind', async () => {
    const storage = createMemoryStorage();
    const snowdrop = createSnowdrop({ storage, mockLatencyMs: 0 });
    const clearHistory = vi.spyOn(snowdrop.admin, 'clearHistory');
    await snowdrop.start();
    expect(clearHistory).not.toHaveBeenCalled();
    await snowdrop.dispose();
  });
});

describe('createSnowdrop: connecting after a failure', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

  function spies(snowdrop: ReturnType<typeof createSnowdrop>) {
    return {
      notifications: vi.spyOn(snowdrop.notifications, 'start'),
      plugins: vi.spyOn(snowdrop.plugins, 'startAll'),
      outbox: vi.spyOn(snowdrop.send, 'restoreOutbox'),
      history: vi.spyOn(snowdrop.historyImport, 'start'),
    };
  }

  it('runs every post-connect step when a Retry succeeds after a failed first connect', async () => {
    quiet();
    const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const ran = spies(snowdrop);
    vi.spyOn(snowdrop.backend, 'connect').mockRejectedValueOnce(new Error('down'));

    await expect(snowdrop.start()).rejects.toThrow('down');
    expect(snowdrop.stores.session.getState().link).toBe('error');
    for (const spy of Object.values(ran)) expect(spy).not.toHaveBeenCalled();

    // The Retry buttons call SyncService directly, not Snowdrop.start().
    await snowdrop.sync.start();
    await snowdrop.sync.settled();
    expect(snowdrop.stores.session.getState().phase).toBe('ready');
    for (const spy of Object.values(ran)) expect(spy).toHaveBeenCalledTimes(1);
    expect(snowdrop.plugins.get('clear-urls')?.status).toBe('running');

    // And a later start() (e.g. after linking) does not run them again.
    await snowdrop.start();
    for (const spy of Object.values(ran)) expect(spy).toHaveBeenCalledTimes(1);
    await snowdrop.dispose();
  });

  it('does not skip the other steps when one of them fails, and tries it again later', async () => {
    quiet();
    const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const ran = spies(snowdrop);
    ran.outbox.mockRejectedValueOnce(new Error('storage trouble'));

    await snowdrop.start();
    expect(snowdrop.stores.session.getState().phase).toBe('ready');
    expect(ran.notifications).toHaveBeenCalledTimes(1);
    expect(ran.history).toHaveBeenCalledTimes(1);
    expect(ran.plugins).toHaveBeenCalledTimes(1);
    expect(ran.outbox).toHaveBeenCalledTimes(1);

    // The failed step is pending still: the next successful connect runs it.
    snowdrop.stores.session.getState().setLink('error');
    await snowdrop.sync.start();
    await snowdrop.sync.settled();
    expect(ran.outbox).toHaveBeenCalledTimes(2);
    expect(ran.plugins).toHaveBeenCalledTimes(1);
    await snowdrop.dispose();
  });
});
