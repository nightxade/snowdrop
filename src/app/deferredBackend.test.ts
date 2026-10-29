import { describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { MockBackend } from '@/core/backend/mock';
import { SignalCliBackend } from '@/core/backend/signal-cli';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DEFAULT_DESKTOP_CONNECTION } from '@/core/stores';
import { BackendRegistry, BUILTIN_BACKENDS, type BackendEnvironment } from './backends';
import { deferredBackend, FORWARDING, OPTIONAL_METHODS } from './deferredBackend';

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

  it('exposes polls before the adapter loads and forwards votes and ends after', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('signal-cli', new Set(['votePoll', 'terminatePoll']), ready);
    expect('votePoll' in deferred).toBe(true);
    expect('terminatePoll' in deferred).toBe(true);
    const votePoll = vi.fn(() => Promise.resolve());
    const terminatePoll = vi.fn(() => Promise.resolve());
    resolve({ kind: 'signal-cli', votePoll, terminatePoll } as unknown as ChatBackend);
    const vote = {
      conversationId: 'group:g' as never,
      pollAuthorId: 'ana',
      pollSentAt: 5,
      optionIndexes: [1],
      voteCount: 1,
    };
    await deferred.votePoll?.(vote);
    await deferred.terminatePoll?.('group:g' as never, 5);
    expect(votePoll).toHaveBeenCalledWith(vote);
    expect(terminatePoll).toHaveBeenCalledWith('group:g', 5);
    // An adapter without them offers no polls at all.
    expect('votePoll' in deferredBackend('mock', new Set(), ready)).toBe(false);
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

  describe('forwarding every ChatBackend member', () => {
    const ARGS = ['arg-1', 'arg-2', 'arg-3', 'arg-4', 'arg-5'];
    const RESULT = { sentinel: true };
    type Fn = (...args: unknown[]) => unknown;
    const keys = Object.keys(FORWARDING) as Array<keyof typeof FORWARDING>;
    const forwarded = keys.filter((k) => !['kind', 'getStatus', 'on'].includes(k));

    /** A real backend whose every member is a spy, so each call's arguments can be compared. */
    const fakeReal = () => {
      const spies: Record<string, ReturnType<typeof vi.fn>> = {};
      const real: Record<string, unknown> = { kind: 'signal-cli', getStatus: () => 'connected' };
      for (const key of forwarded) {
        if (key === 'link') continue;
        const kind = FORWARDING[key];
        spies[key] = vi.fn(() =>
          kind === 'flag'
            ? true
            : kind === 'required' || kind === 'async'
              ? Promise.resolve(RESULT)
              : RESULT,
        );
        real[key] = spies[key];
      }
      spies['link.start'] = vi.fn(() => Promise.resolve(RESULT));
      spies['link.finish'] = vi.fn(() => Promise.resolve(RESULT));
      real['link'] = { start: spies['link.start'], finish: spies['link.finish'] };
      return { real: real as unknown as ChatBackend, spies };
    };

    const wrap = (real: ChatBackend) =>
      deferredBackend('signal-cli', new Set(OPTIONAL_METHODS), Promise.resolve(real));

    it('exposes every member when every capability is declared', () => {
      const deferred = wrap(fakeReal().real);
      for (const key of keys) expect(key in deferred, key).toBe(true);
    });

    it('passes every argument of every member through unchanged, and returns the result', async () => {
      const { real, spies } = fakeReal();
      const deferred = wrap(real) as unknown as Record<string, Fn>;
      await Promise.resolve();
      for (const key of forwarded) {
        const kind = FORWARDING[key];
        if (key === 'link') {
          const link = deferred['link'] as unknown as Record<string, Fn>;
          await link['start']!(...ARGS);
          await link['finish']!(...ARGS);
          expect(spies['link.start']).toHaveBeenCalledWith(...ARGS);
          expect(spies['link.finish']).toHaveBeenCalledWith(...ARGS);
          continue;
        }
        const result = deferred[key]!(...ARGS);
        if (kind === 'flag') expect(result, key).toBe(true);
        else if (kind === 'required' || kind === 'async') expect(await result, key).toBe(RESULT);
        else if (kind === 'peek') expect(result, key).toBe(RESULT);
        expect(spies[key], key).toHaveBeenCalledWith(...ARGS);
      }
    });

    it('rejects, or reports false, for what the adapter does not have', async () => {
      const bare = { kind: 'signal-cli', getStatus: () => 'connected' } as unknown as ChatBackend;
      const deferred = wrap(bare) as unknown as Record<string, Fn>;
      for (const key of forwarded) {
        const kind = FORWARDING[key];
        if (kind === 'flag') expect(deferred[key]!(), key).toBe(false);
        else if (kind === 'required' || kind === 'async')
          await expect(deferred[key]!(...ARGS), key).rejects.toThrow(TypeError);
      }
      await expect(
        deferred['link'] ? (deferred['link'] as never as { start: Fn }).start() : 0,
      ).rejects.toThrow(TypeError);
    });

    it('replays fire-and-forget calls made before the adapter loads, in order', async () => {
      let resolve!: (b: ChatBackend) => void;
      const ready = new Promise<ChatBackend>((r) => {
        resolve = r;
      });
      const deferred = deferredBackend(
        'signal-cli',
        new Set(['retainAttachmentUrl', 'releaseAttachmentUrl', 'acknowledge']),
        ready,
      );
      const calls: string[] = [];
      const attachment = { id: 'a1' } as never;
      deferred.retainAttachmentUrl!(attachment);
      deferred.acknowledge!('c1');
      deferred.releaseAttachmentUrl!(attachment);
      resolve({
        kind: 'signal-cli',
        retainAttachmentUrl: () => calls.push('retain'),
        releaseAttachmentUrl: () => calls.push('release'),
        acknowledge: (c: string) => calls.push(`ack ${c}`),
      } as unknown as ChatBackend);
      await ready;
      await Promise.resolve();
      expect(calls).toEqual(['retain', 'ack c1', 'release']);
    });

    it('delivers custom emoji through the wrapper once the adapter is known', async () => {
      let resolve!: (b: ChatBackend) => void;
      const ready = new Promise<ChatBackend>((r) => {
        resolve = r;
      });
      const deferred = deferredBackend('signal-cli', new Set(), ready);
      expect(deferred.supportsCustomEmojiDelivery?.()).toBe(false);
      resolve({
        kind: 'signal-cli',
        supportsCustomEmojiDelivery: () => true,
      } as unknown as ChatBackend);
      await ready;
      expect(deferred.supportsCustomEmojiDelivery?.()).toBe(true);
    });

    it('forwards resolveAttachmentUrl options, so Retry refetches', async () => {
      const resolveAttachmentUrl = vi.fn(() => Promise.resolve('blob:fresh'));
      const deferred = wrap({ kind: 'signal-cli', resolveAttachmentUrl } as unknown as ChatBackend);
      const attachment = { id: 'a1' } as never;
      await deferred.resolveAttachmentUrl!('conv' as never, attachment, { forceRefresh: true });
      expect(resolveAttachmentUrl).toHaveBeenCalledWith('conv', attachment, { forceRefresh: true });
    });
  });
});
