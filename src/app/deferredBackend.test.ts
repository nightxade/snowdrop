import { describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { MockBackend } from '@/core/backend/mock';
import { SignalCliBackend } from '@/core/backend/signal-cli';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DEFAULT_DESKTOP_CONNECTION } from '@/core/stores';
import { BackendRegistry, BUILTIN_BACKENDS, type BackendEnvironment } from './backends';
import { deferredBackend, OPTIONAL_METHODS } from './deferredBackend';

const present = (b: ChatBackend) =>
  OPTIONAL_METHODS.filter((m) => (b as unknown as Record<string, unknown>)[m] !== undefined).sort();

describe('deferredBackend', () => {
  it('declares exactly the optional methods each real adapter has', () => {
    const mock = new MockBackend({ latencyMs: 0 });
    const cli = new SignalCliBackend({ baseUrl: '/signal-cli', account: null });
    const registry = new BackendRegistry(BUILTIN_BACKENDS);
    expect([...registry.get('mock')!.capabilities].sort()).toEqual(present(mock));
    expect([...registry.get('signal-cli')!.capabilities].sort()).toEqual(present(cli));
  });

  it('loads every registered adapter through its factory, with matching kind and capabilities', async () => {
    const env: BackendEnvironment = {
      clock: new ManualScheduler(0),
      scheduler: new ManualScheduler(0),
      storage: createMemoryStorage(),
      connection: {
        backend: null,
        daemonUrl: '/signal-cli',
        account: null,
        mockLiveliness: false,
        desktop: DEFAULT_DESKTOP_CONNECTION,
      },
      updateConnection: () => undefined,
      overrides: { mockLatencyMs: 0 },
    };
    for (const registration of BUILTIN_BACKENDS) {
      const backend = (await registration.load())(env);
      expect(backend.kind).toBe(registration.kind);
      expect(present(backend)).toEqual([...registration.capabilities].sort());
    }
  });

  it('exposes capabilities before the adapter loads and forwards calls after', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend(
      'mock',
      new BackendRegistry(BUILTIN_BACKENDS).get('mock')!.capabilities,
      ready,
    );
    expect(deferred.kind).toBe('mock');
    expect('fetchHistory' in deferred).toBe(true);
    expect('resolveAttachmentUrl' in deferred).toBe(false);
    expect(deferred.getStatus()).toBe('connecting');

    // Subscriptions made early are attached on load; unsubscribing early works too.
    const early = vi.fn();
    const dropped = vi.fn();
    deferred.on('status', early);
    const off = deferred.on('status', dropped);
    off();

    const real = new MockBackend({ latencyMs: 0, scheduler: new ManualScheduler() });
    const connecting = deferred.connect();
    resolve(real);
    await connecting;
    expect(deferred.getStatus()).toBe(real.getStatus());
    expect(early).toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
  });

  it('rejects calls when the adapter fails to load', async () => {
    const deferred = deferredBackend(
      'signal-cli',
      new Set(['link']),
      Promise.reject(new Error('chunk failed')),
    );
    await expect(deferred.connect()).rejects.toThrow('chunk failed');
    expect(deferred.link).toBeDefined();
  });

  it('forwards the sticker pack install and reports its support only once the adapter is known', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend(
      'signal-cli',
      new Set(['getStickerPack', 'installStickerPack']),
      ready,
    );
    expect(deferred.supportsStickerPackInstall?.()).toBe(false);
    const sticker = { packId: 'ab12', stickerId: 0 };
    const install = vi.fn(() => Promise.resolve());
    const details = {
      packId: 'ab12',
      title: 'T',
      author: 'A',
      installed: false,
      cover: { stickerId: 0, emoji: '' },
      stickers: [],
    };
    const real = {
      kind: 'signal-cli',
      supportsStickerPackInstall: () => true,
      installStickerPack: install,
      getStickerPack: vi.fn(() => Promise.resolve(details)),
    } as unknown as ChatBackend;
    const pending = deferred.installStickerPack!(sticker);
    resolve(real);
    await pending;
    expect(install).toHaveBeenCalledWith(sticker);
    expect(deferred.supportsStickerPackInstall?.()).toBe(true);
    expect(await deferred.getStickerPack!(sticker)).toBe(details);
  });

  it('forwards attachment backfill and reports its support only once the adapter is known', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('signal-cli', new Set(['requestAttachmentBackfill']), ready);
    expect(deferred.supportsAttachmentBackfill?.()).toBe(false);
    const request = vi.fn(() => Promise.resolve());
    const real = {
      kind: 'signal-cli',
      supportsAttachmentBackfill: () => true,
      requestAttachmentBackfill: request,
    } as unknown as ChatBackend;
    const pending = deferred.requestAttachmentBackfill!('conv' as never, 'author', 5, ['a1']);
    resolve(real);
    await pending;
    expect(request).toHaveBeenCalledWith('conv', 'author', 5, ['a1']);
    expect(deferred.supportsAttachmentBackfill?.()).toBe(true);
  });
});
