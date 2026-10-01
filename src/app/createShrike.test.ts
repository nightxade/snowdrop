import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage, loadVersioned } from '@/core/persistence';
import { settingsSchema, spacesSchema, spacesSelectors } from '@/core/stores';
import { STYLE_IDS } from '@/core/themes';
import { createShrike } from './createShrike';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

describe('createShrike', () => {
  it('wires backend, sync, stores, plugins and themes together', async () => {
    const scheduler = new ManualScheduler(NOW);
    const storage = createMemoryStorage();
    const shrike = createShrike({
      storage,
      document,
      clock: scheduler,
      scheduler,
      mockLatencyMs: 0,
    });
    await shrike.start();

    const { stores } = shrike;
    expect(stores.session.getState().ready).toBe(true);
    expect(Object.keys(stores.conversations.getState().byId)).toHaveLength(22);
    // Default spaces were seeded and persisted.
    expect(spacesSelectors.orderedIds(stores.spaces.getState())).toHaveLength(3);
    expect(Object.keys(loadVersioned(storage, spacesSchema).spaces)).toHaveLength(3);
    // Default-on plugins are running and feed the send pipeline.
    expect(shrike.plugins.get('clear-urls')?.status).toBe('running');
    expect(shrike.registries.findSlash('shrug')).toBeDefined();
    // Theme applied, and it follows settings.
    expect(document.getElementById(STYLE_IDS.theme)).not.toBeNull();
    stores.settings.getState().update('appearance', { themeId: 'linen' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('linen');
    expect(loadVersioned(storage, settingsSchema).appearance.themeId).toBe('linen');

    // Liveliness runs on the injected scheduler.
    const before = Object.values(stores.conversations.getState().byId).reduce(
      (n, c) => Math.max(n, c.lastActivityAt),
      0,
    );
    scheduler.advance(60_000);
    await shrike.sync.idle();
    const after = Object.values(stores.conversations.getState().byId).reduce(
      (n, c) => Math.max(n, c.lastActivityAt),
      0,
    );
    expect(after).toBeGreaterThan(before);

    // Commands drive the UI store.
    await shrike.commands.execute('core.toggleMemberList');
    expect(stores.ui.getState().memberListOpen).toBe(false);

    await shrike.dispose();
    expect(stores.session.getState().status).toBe('offline');
  });

  it('does not re-seed spaces the user deleted', async () => {
    const storage = createMemoryStorage();
    const first = createShrike({ storage, mockLatencyMs: 0 });
    await first.start();
    for (const id of spacesSelectors.orderedIds(first.stores.spaces.getState()))
      first.stores.spaces.getState().deleteSpace(id);
    await first.dispose();

    const second = createShrike({ storage, mockLatencyMs: 0 });
    await second.start();
    expect(spacesSelectors.orderedIds(second.stores.spaces.getState())).toHaveLength(0);
    await second.dispose();
  });

  it('keeps running when a plugin fails', async () => {
    const shrike = createShrike({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await shrike.start();
    shrike.registries.sendTransforms.add({
      owner: 'evil',
      transform: () => {
        throw new Error('x');
      },
    });
    const conv = Object.values(shrike.stores.conversations.getState().byId)[0]!.id;
    await shrike.send.send({
      conversationId: conv,
      text: 'still works',
      mentionIds: [],
      attachments: [],
    });
    expect(error).toHaveBeenCalled();
    await shrike.dispose();
  });
});
