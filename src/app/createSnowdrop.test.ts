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
import { createSnowdrop } from './createSnowdrop';
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
    expect(stores.session.getState().ready).toBe(true);
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
    expect(stores.session.getState().status).toBe('offline');
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
    expect(snowdrop.stores.session.getState().ready).toBe(true);
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
