import { describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { FeatureStore } from '@/core/backend/features';
import { MockBackend } from '@/core/backend/mock';
import { SignalCliBackend } from '@/core/backend/signal-cli';
import { featuresForVersion } from '@/core/backend/signal-cli/capabilities';
import { ManualScheduler, UnsupportedError } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DEFAULT_DESKTOP_CONNECTION } from '@/core/stores';
import { BackendRegistry, BUILTIN_BACKENDS, type BackendEnvironment } from './backends';
import { deferredBackend, FORWARDING, PEEK_BEFORE_LOAD } from './deferredBackend';

const memberKeys = Object.keys(FORWARDING) as Array<keyof ChatBackend>;

describe('deferredBackend', () => {
  it("declares exactly each real adapter's static features", () => {
    const registry = new BackendRegistry(BUILTIN_BACKENDS);
    expect([...registry.get('mock')!.features].sort()).toEqual([...MockBackend.FEATURES].sort());
    expect([...registry.get('signal-cli')!.features].sort()).toEqual(
      [...SignalCliBackend.FEATURES].sort(),
    );
  });

  it('starts each real adapter with its static features', () => {
    const mock = new MockBackend({ latencyMs: 0 });
    const cli = new SignalCliBackend({ baseUrl: '/signal-cli', account: null });
    expect([...mock.capabilities.features].sort()).toEqual([...MockBackend.FEATURES].sort());
    expect([...cli.capabilities.features].sort()).toEqual([...SignalCliBackend.FEATURES].sort());
  });

  it('loads every registered adapter through its factory, with matching kind, features and every member', async () => {
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
      expect([...backend.capabilities.features].sort()).toEqual([...registration.features].sort());
      for (const key of memberKeys)
        expect(key in backend, `${registration.kind}.${key}`).toBe(true);
    }
  });

  it('exposes capabilities before the adapter loads and forwards calls after', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend(
      'mock',
      new BackendRegistry(BUILTIN_BACKENDS).get('mock')!.features,
      ready,
    );
    expect(deferred.kind).toBe('mock');
    expect(deferred.capabilities.features.has('history')).toBe(true);
    expect(deferred.capabilities.features.has('attachmentUrls')).toBe(false);
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
      ['deviceLinking'],
      Promise.reject(new Error('chunk failed')),
    );
    await expect(deferred.connect()).rejects.toThrow('chunk failed');
    await expect(deferred.link.start()).rejects.toThrow('chunk failed');
    // What the registration declared stays; nothing is mirrored from an adapter that never came.
    expect(deferred.capabilities.features.has('deviceLinking')).toBe(true);
  });

  it('exposes polls before the adapter loads and forwards votes and ends after', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('signal-cli', ['polls'], ready);
    expect(deferred.capabilities.features.has('polls')).toBe(true);
    const votePoll = vi.fn(() => Promise.resolve());
    const terminatePoll = vi.fn(() => Promise.resolve());
    resolve({
      kind: 'signal-cli',
      capabilities: new FeatureStore(),
      votePoll,
      terminatePoll,
    } as unknown as ChatBackend);
    const vote = {
      conversationId: 'group:g' as never,
      pollAuthorId: 'ana',
      pollSentAt: 5,
      optionIndexes: [1],
      voteCount: 1,
    };
    await deferred.votePoll(vote);
    await deferred.terminatePoll('group:g' as never, 5);
    expect(votePoll).toHaveBeenCalledWith(vote);
    expect(terminatePoll).toHaveBeenCalledWith('group:g', 5);
    // An adapter without them offers no polls at all.
    expect(deferredBackend('mock', [], ready).capabilities.features.has('polls')).toBe(false);
  });

  it('forwards the sticker pack install and reports its support only once the adapter is known', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('signal-cli', ['stickers'], ready);
    expect(deferred.capabilities.features.has('stickerPackInstall')).toBe(false);
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
      capabilities: new FeatureStore(['stickerPackInstall']),
      installStickerPack: install,
      getStickerPack: vi.fn(() => Promise.resolve(details)),
    } as unknown as ChatBackend;
    const pending = deferred.installStickerPack(sticker);
    resolve(real);
    await pending;
    expect(install).toHaveBeenCalledWith(sticker);
    expect(deferred.capabilities.features.has('stickerPackInstall')).toBe(true);
    expect(await deferred.getStickerPack(sticker)).toBe(details);
  });

  it('forwards attachment backfill and reports its support only once the adapter is known', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('signal-cli', [], ready);
    expect(deferred.capabilities.features.has('attachmentBackfill')).toBe(false);
    const request = vi.fn(() => Promise.resolve());
    const real = {
      kind: 'signal-cli',
      capabilities: new FeatureStore(['attachmentBackfill']),
      requestAttachmentBackfill: request,
    } as unknown as ChatBackend;
    const pending = deferred.requestAttachmentBackfill('conv' as never, 'author', 5, ['a1']);
    resolve(real);
    await pending;
    expect(request).toHaveBeenCalledWith('conv', 'author', 5, ['a1']);
    expect(deferred.capabilities.features.has('attachmentBackfill')).toBe(true);
  });

  describe('forwarding every ChatBackend member', () => {
    const ARGS = ['arg-1', 'arg-2', 'arg-3', 'arg-4', 'arg-5'];
    const RESULT = { sentinel: true };
    type Fn = (...args: unknown[]) => unknown;
    const keys = Object.keys(FORWARDING) as Array<keyof typeof FORWARDING>;
    const forwarded = keys.filter((k) => !['kind', 'getStatus', 'on', 'capabilities'].includes(k));

    /** A real backend whose every member is a spy, so each call's arguments can be compared. */
    const fakeReal = () => {
      const spies: Record<string, ReturnType<typeof vi.fn>> = {};
      const real: Record<string, unknown> = {
        kind: 'signal-cli',
        getStatus: () => 'connected',
        capabilities: new FeatureStore(),
      };
      for (const key of forwarded) {
        if (key === 'link') continue;
        const kind = FORWARDING[key];
        spies[key] = vi.fn(() => (kind === 'async' ? Promise.resolve(RESULT) : RESULT));
        real[key] = spies[key];
      }
      spies['link.start'] = vi.fn(() => Promise.resolve(RESULT));
      spies['link.finish'] = vi.fn(() => Promise.resolve(RESULT));
      real['link'] = { start: spies['link.start'], finish: spies['link.finish'] };
      return { real: real as unknown as ChatBackend, spies };
    };

    const wrap = (real: ChatBackend) => deferredBackend('signal-cli', [], Promise.resolve(real));

    it('exposes every ChatBackend member', () => {
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
        if (kind === 'async') expect(await result, key).toBe(RESULT);
        else if (kind === 'peek') expect(result, key).toBe(RESULT);
        expect(spies[key], key).toHaveBeenCalledWith(...ARGS);
      }
    });

    it('rejects with what the adapter rejects with, an UnsupportedError included', async () => {
      const real = {
        kind: 'signal-cli',
        getStatus: () => 'connected',
        capabilities: new FeatureStore(),
        votePoll: () => Promise.reject(new UnsupportedError('votePoll')),
      } as unknown as ChatBackend;
      const deferred = wrap(real);
      const error: unknown = await deferred.votePoll({} as never).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UnsupportedError);
    });

    it('answers a peek before the adapter loads without throwing', () => {
      const deferred = deferredBackend('signal-cli', [], new Promise<ChatBackend>(() => undefined));
      expect(deferred.peekAvatarUrl({ kind: 'contact', id: 'ana' })).toBeUndefined();
      expect(deferred.hasPendingEvents()).toBe(false);
    });

    it('replays fire-and-forget calls made before the adapter loads, in order', async () => {
      let resolve!: (b: ChatBackend) => void;
      const ready = new Promise<ChatBackend>((r) => {
        resolve = r;
      });
      const deferred = deferredBackend('signal-cli', [], ready);
      const calls: string[] = [];
      const attachment = { id: 'a1' } as never;
      deferred.retainAttachmentUrl(attachment);
      deferred.acknowledge('c1');
      deferred.releaseAttachmentUrl(attachment);
      resolve({
        kind: 'signal-cli',
        capabilities: new FeatureStore(),
        retainAttachmentUrl: () => calls.push('retain'),
        releaseAttachmentUrl: () => calls.push('release'),
        acknowledge: (c: string) => calls.push(`ack ${c}`),
      } as unknown as ChatBackend);
      await ready;
      await Promise.resolve();
      expect(calls).toEqual(['retain', 'ack c1', 'release']);
    });

    describe('capabilities', () => {
      const pending = () => {
        let resolve!: (b: ChatBackend) => void;
        const ready = new Promise<ChatBackend>((r) => {
          resolve = r;
        });
        return { ready, resolve };
      };

      it("is the registration's before the adapter loads, then mirrors it", async () => {
        const { ready, resolve } = pending();
        const deferred = deferredBackend('signal-cli', ['pins'], ready);
        expect([...deferred.capabilities.features]).toEqual(['pins']);
        resolve({
          kind: 'signal-cli',
          capabilities: new FeatureStore(['customEmojiDelivery', 'readSync']),
        } as unknown as ChatBackend);
        await ready;
        expect([...deferred.capabilities.features].sort()).toEqual([
          'customEmojiDelivery',
          'readSync',
        ]);
      });

      it('tells a subscriber attached before the load about the later change', async () => {
        const { ready, resolve } = pending();
        const deferred = deferredBackend('signal-cli', [], ready);
        const seen: boolean[] = [];
        deferred.capabilities.subscribe(() =>
          seen.push(deferred.capabilities.features.has('customEmojiDelivery')),
        );
        resolve({
          kind: 'signal-cli',
          capabilities: new FeatureStore(['customEmojiDelivery']),
        } as unknown as ChatBackend);
        await ready;
        expect(seen).toEqual([true]);
      });

      it('forwards a version-dependent feature added after connect, with a new set each time', async () => {
        const adapter = new FeatureStore();
        const deferred = deferredBackend(
          'signal-cli',
          [],
          Promise.resolve({ kind: 'signal-cli', capabilities: adapter } as unknown as ChatBackend),
        );
        await Promise.resolve();
        const before = deferred.capabilities.features;
        const seen: string[][] = [];
        deferred.capabilities.subscribe(() => seen.push([...deferred.capabilities.features]));
        adapter.set(featuresForVersion('0.14.8-snowdrop-history.19'));
        expect(deferred.capabilities.features).not.toBe(before);
        expect(deferred.capabilities.features.has('readSync')).toBe(true);
        expect(seen).toHaveLength(1);
        adapter.set([]);
        expect(deferred.capabilities.features.size).toBe(0);
        expect(seen).toHaveLength(2);
      });
    });

    it('forwards resolveAttachmentUrl options, so Retry refetches', async () => {
      const resolveAttachmentUrl = vi.fn(() => Promise.resolve('blob:fresh'));
      const deferred = wrap({
        kind: 'signal-cli',
        capabilities: new FeatureStore(),
        resolveAttachmentUrl,
      } as unknown as ChatBackend);
      const attachment = { id: 'a1' } as never;
      await deferred.resolveAttachmentUrl('conv' as never, attachment, { forceRefresh: true });
      expect(resolveAttachmentUrl).toHaveBeenCalledWith('conv', attachment, { forceRefresh: true });
    });
  });
});

describe('the shutdown signal', () => {
  const stubs = () => {
    const seen: Record<string, AbortSignal | undefined> = {};
    const hang = (name: string, at: number) =>
      vi.fn((...args: unknown[]) => {
        seen[name] = (args[at] as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise(() => undefined);
      });
    const real = {
      kind: 'mock',
      capabilities: new FeatureStore(),
      send: hang('send', 1),
      fetchHistory: hang('fetchHistory', 2),
      resolveAttachmentUrl: hang('resolveAttachmentUrl', 2),
      readAttachmentBlob: hang('readAttachmentBlob', 2),
      link: { start: hang('link.start', 0), finish: hang('link.finish', 2) },
    };
    return { seen, real: real as unknown as ChatBackend, spies: real };
  };

  it('reaches every long call, with the caller’s own options kept', async () => {
    const shutdown = new AbortController();
    const { seen, real, spies } = stubs();
    const deferred = deferredBackend('mock', [], Promise.resolve(real), shutdown.signal);
    void deferred.send({ conversationId: 'c' as never, body: '', ranges: [] });
    void deferred.fetchHistory('c' as never, { limit: 1 });
    void deferred.resolveAttachmentUrl('c' as never, { id: 'a' } as never, {
      forceRefresh: true,
    });
    void deferred.readAttachmentBlob('c' as never, { id: 'a' } as never);
    void deferred.link.start();
    void deferred.link.finish('uri', 'name');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(Object.keys(seen).sort()).toEqual([
      'fetchHistory',
      'link.finish',
      'link.start',
      'readAttachmentBlob',
      'resolveAttachmentUrl',
      'send',
    ]);
    for (const signal of Object.values(seen)) expect(signal?.aborted).toBe(false);
    expect(spies.resolveAttachmentUrl).toHaveBeenCalledWith(
      'c',
      { id: 'a' },
      expect.objectContaining({ forceRefresh: true }),
    );
    shutdown.abort();
    for (const signal of Object.values(seen)) expect(signal?.aborted).toBe(true);
  });

  it('also honours the signal the caller passed', async () => {
    const shutdown = new AbortController();
    const { seen, real } = stubs();
    const deferred = deferredBackend('mock', [], Promise.resolve(real), shutdown.signal);
    const own = new AbortController();
    void deferred.send(
      { conversationId: 'c' as never, body: '', ranges: [] },
      { signal: own.signal },
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(seen.send?.aborted).toBe(false);
    own.abort();
    expect(seen.send?.aborted).toBe(true);
    expect(shutdown.signal.aborted).toBe(false);
  });

  it('leaves the arguments alone without one', async () => {
    const { seen, real, spies } = stubs();
    const deferred = deferredBackend('mock', [], Promise.resolve(real));
    void deferred.send({ conversationId: 'c' as never, body: '', ranges: [] });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(spies.send).toHaveBeenCalledWith({ conversationId: 'c', body: '', ranges: [] });
    expect(seen.send).toBeUndefined();
  });
});

describe('peeks before load', () => {
  it('every peek member has an answer for before the adapter loads', () => {
    const peeks = Object.entries(FORWARDING)
      .filter(([, kind]) => kind === 'peek')
      .map(([key]) => key)
      .sort();
    expect(Object.keys(PEEK_BEFORE_LOAD).sort()).toEqual(peeks);
  });
});
