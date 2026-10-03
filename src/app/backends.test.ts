import { describe, expect, it } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { createMemoryStorage, loadVersioned } from '@/core/persistence';
import { createSettingsSchema, settingsSchema } from '@/core/stores';
import {
  BackendRegistry,
  BUILTIN_BACKENDS,
  DuplicateBackendError,
  type BackendRegistration,
} from './backends';
import { createShrike } from './createShrike';

const fake = (kind: string): BackendRegistration => ({
  kind,
  label: kind.toUpperCase(),
  load: () => Promise.reject(new Error('not loaded in this test')),
  capabilities: new Set(),
  history: { kind: 'memory' },
});

function storageWith(backend: string) {
  const storage = createMemoryStorage();
  const data = {
    ...settingsSchema.defaults(),
    connection: { ...settingsSchema.defaults().connection, backend },
  };
  storage.setItem(settingsSchema.key, JSON.stringify({ v: settingsSchema.version, data }));
  return storage;
}

describe('backend registry', () => {
  it('lists registrations in order and rejects duplicates and bad kinds', () => {
    const registry = new BackendRegistry(BUILTIN_BACKENDS);
    expect(registry.options().map((o) => o.kind)).toEqual(['mock', 'signal-cli']);
    registry.register(fake('matrix-bridge'));
    expect(registry.options().at(-1)).toEqual({ kind: 'matrix-bridge', label: 'MATRIX-BRIDGE' });
    expect(() => {
      registry.register(fake('mock'));
    }).toThrow(DuplicateBackendError);
    expect(() => {
      registry.register(fake('Not A Kind'));
    }).toThrow(TypeError);
  });

  it('parses a stored backend only when it is registered', () => {
    const registry = new BackendRegistry([...BUILTIN_BACKENDS, fake('matrix-bridge')]);
    const schema = createSettingsSchema({ isBackendKind: (k) => registry.has(k) });
    expect(loadVersioned(storageWith('matrix-bridge'), schema).connection.backend).toBe(
      'matrix-bridge',
    );
    expect(loadVersioned(storageWith('irc'), schema).connection.backend).toBeNull();
    expect(loadVersioned(storageWith('<script>'), settingsSchema).connection.backend).toBeNull();
  });

  it('runs createShrike on a newly registered adapter with no other changes', async () => {
    const { MockBackend } = await import('@/core/backend/mock');
    let created: ChatBackend | null = null;
    const registry = new BackendRegistry([
      ...BUILTIN_BACKENDS,
      {
        ...fake('matrix-bridge'),
        // Stand-in transport: the mock world under another kind.
        load: () =>
          Promise.resolve(() => {
            const backend = Object.assign(new MockBackend({ latencyMs: 0 }), {
              kind: 'matrix-bridge',
            });
            created = backend;
            return backend;
          }),
        capabilities: new Set(['fetchHistory', 'adminDelete', 'pinMessage', 'updateConversation']),
      },
    ]);
    const shrike = createShrike({ storage: storageWith('matrix-bridge'), backends: registry });
    expect(shrike.backend.kind).toBe('matrix-bridge');
    await shrike.start();
    expect(created).not.toBeNull();
    expect(shrike.stores.session.getState().backendKind).toBe('matrix-bridge');
    expect(shrike.stores.session.getState().ready).toBe(true);
    await shrike.dispose();
  });
});
