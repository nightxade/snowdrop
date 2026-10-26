// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AVATAR_CONCURRENCY, AVATAR_MISS_TTL_MS, AvatarResolver, sniffAvatarType } from './avatars';
import { JsonRpcClient } from './rpc';
import { FakeDaemon, flush, type RpcReply } from './testing';

const JPEG = '/9j/4AAQSkZJRgABAQ==';
const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const GIF = 'R0lGODlhAQABAAAAACw=';
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAA=';
const NOT_FOUND: RpcReply = { error: { code: -1, message: 'Could not find avatar' } };
const PARAMS = { contact: 'a' };

function setup(options: { concurrency?: number; maxEntries?: number } = {}) {
  let time = 1_000;
  const daemon = new FakeDaemon();
  const rpc = new JsonRpcClient({ baseUrl: '/x', fetch: daemon.fetch });
  const resolver = new AvatarResolver({ rpc, now: () => time, ...options });
  return {
    daemon,
    resolver,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('sniffAvatarType', () => {
  it('recognises the four image types an avatar can be, and nothing else', () => {
    expect(sniffAvatarType(JPEG)).toBe('image/jpeg');
    expect(sniffAvatarType(PNG)).toBe('image/png');
    expect(sniffAvatarType(GIF)).toBe('image/gif');
    expect(sniffAvatarType(WEBP)).toBe('image/webp');
    expect(sniffAvatarType(btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffAvatarType(btoa('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffAvatarType('')).toBeNull();
    expect(sniffAvatarType('!!!not base64!!!')).toBeNull();
  });
});

describe('AvatarResolver', () => {
  it('answers a data URL, labelled by what the bytes are, and remembers it', async () => {
    const { daemon, resolver } = setup();
    daemon.reply('getAvatar', { data: PNG });
    expect(resolver.peek('k')).toBeUndefined();
    expect(await resolver.resolve('k', [PARAMS])).toBe(`data:image/png;base64,${PNG}`);
    expect(resolver.peek('k')).toBe(`data:image/png;base64,${PNG}`);
    expect(await resolver.resolve('k', [PARAMS])).toBe(`data:image/png;base64,${PNG}`);
    expect(daemon.callsTo('getAvatar')).toHaveLength(1);
  });

  it('shows nothing for bytes that are not a plain image (SVG, HTML, junk)', async () => {
    const { daemon, resolver } = setup();
    daemon.reply('getAvatar', { data: btoa('<svg onload="alert(1)"/>') });
    expect(await resolver.resolve('k', [PARAMS])).toBeNull();
  });

  it('shares one call between concurrent askers of the same picture', async () => {
    const { daemon, resolver } = setup();
    daemon.reply('getAvatar', { data: JPEG });
    const [a, b, c] = await Promise.all([
      resolver.resolve('k', [PARAMS]),
      resolver.resolve('k', [PARAMS]),
      resolver.resolve('k', [PARAMS]),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(daemon.callsTo('getAvatar')).toHaveLength(1);
  });

  it('runs at most a few calls at once and lets the rest wait their turn', async () => {
    const { daemon, resolver } = setup();
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    daemon.handle('getAvatar', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { result: { data: JPEG } };
    });
    const results = Array.from({ length: 10 }, (_, i) => resolver.resolve(`k${i}`, [PARAMS]));
    await flush();
    expect(active).toBe(AVATAR_CONCURRENCY);
    while (releases.length > 0) {
      releases.shift()?.();
      await flush();
    }
    expect((await Promise.all(results)).every((r) => r?.startsWith('data:image/jpeg'))).toBe(true);
    expect(peak).toBe(AVATAR_CONCURRENCY);
    expect(daemon.callsTo('getAvatar')).toHaveLength(10);
  });

  it('serves the newest waiting request first, since it is the one on screen', async () => {
    const { daemon, resolver } = setup({ concurrency: 1 });
    const order: string[] = [];
    const releases: (() => void)[] = [];
    daemon.handle('getAvatar', async (params) => {
      order.push(String(params.contact));
      await new Promise<void>((resolve) => releases.push(resolve));
      return { result: { data: JPEG } };
    });
    const all = ['a', 'b', 'c', 'd'].map((id) => resolver.resolve(id, [{ contact: id }]));
    await flush();
    while (order.length < 4) {
      releases.shift()?.();
      await flush();
    }
    releases.shift()?.();
    await Promise.all(all);
    expect(order).toEqual(['a', 'd', 'c', 'b']);
  });

  it('tries each source in order and stops at the first that has a picture', async () => {
    const { daemon, resolver } = setup();
    daemon.handle('getAvatar', (params) =>
      params.contact ? NOT_FOUND : { result: { data: JPEG } },
    );
    expect(await resolver.resolve('k', [{ contact: 'a' }, { profile: 'a' }])).toMatch(
      /^data:image\/jpeg/u,
    );
    expect(daemon.callsTo('getAvatar')).toEqual([{ contact: 'a' }, { profile: 'a' }]);
    // The first source has one: the second is never asked.
    const other = setup();
    other.daemon.reply('getAvatar', { data: PNG });
    await other.resolver.resolve('k', [{ contact: 'a' }, { profile: 'a' }]);
    expect(other.daemon.callsTo('getAvatar')).toEqual([{ contact: 'a' }]);
  });

  it('remembers "no picture" for a while, then asks again', async () => {
    const { daemon, resolver, advance } = setup();
    daemon.handle('getAvatar', () => NOT_FOUND);
    expect(await resolver.resolve('k', [PARAMS])).toBeNull();
    expect(resolver.peek('k')).toBeNull();
    expect(await resolver.resolve('k', [PARAMS])).toBeNull();
    expect(daemon.callsTo('getAvatar')).toHaveLength(1);
    advance(AVATAR_MISS_TTL_MS);
    expect(resolver.peek('k')).toBeUndefined();
    daemon.reply('getAvatar', { data: JPEG });
    expect(await resolver.resolve('k', [PARAMS])).toMatch(/^data:image\/jpeg/u);
  });

  it('treats a daemon that is down as unknown, not as "no picture"', async () => {
    const { daemon, resolver } = setup();
    daemon.up = false;
    await expect(resolver.resolve('k', [PARAMS])).rejects.toThrow();
    expect(resolver.peek('k')).toBeUndefined();
    daemon.up = true;
    daemon.reply('getAvatar', { data: JPEG });
    expect(await resolver.resolve('k', [PARAMS])).toMatch(/^data:image\/jpeg/u);
  });

  describe('invalidation', () => {
    it('forgets a picture, so the next ask fetches the new one', async () => {
      const { daemon, resolver } = setup();
      daemon.reply('getAvatar', { data: JPEG });
      await resolver.resolve('k', [PARAMS]);
      resolver.invalidate('k');
      expect(resolver.peek('k')).toBeUndefined();
      daemon.reply('getAvatar', { data: PNG });
      expect(await resolver.resolve('k', [PARAMS])).toBe(`data:image/png;base64,${PNG}`);
      expect(daemon.callsTo('getAvatar')).toHaveLength(2);
    });

    it('does not remember a download that began before the picture changed', async () => {
      const { daemon, resolver } = setup();
      let release: () => void = () => undefined;
      daemon.handle('getAvatar', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: { data: JPEG } };
      });
      const stale = resolver.resolve('k', [PARAMS]);
      await flush();
      resolver.invalidate('k');
      release();
      await stale;
      expect(resolver.peek('k')).toBeUndefined();
    });

    it('keeps other pictures when one is dropped', async () => {
      const { daemon, resolver } = setup();
      daemon.reply('getAvatar', { data: JPEG });
      await resolver.resolve('a', [PARAMS]);
      await resolver.resolve('b', [PARAMS]);
      resolver.invalidate('a');
      expect(resolver.peek('b')).toMatch(/^data:image\/jpeg/u);
    });

    it('can be primed with a picture we already hold, or with none', () => {
      const { resolver } = setup();
      resolver.prime('k', 'data:image/jpeg;base64,AAAA');
      expect(resolver.peek('k')).toBe('data:image/jpeg;base64,AAAA');
      resolver.prime('k', null);
      expect(resolver.peek('k')).toBeNull();
    });

    it('forgets everything on clear, and abandons calls still waiting for a turn', async () => {
      const { daemon, resolver } = setup({ concurrency: 1 });
      daemon.handle('getAvatar', () => new Promise<RpcReply>(() => undefined));
      void resolver.resolve('first', [PARAMS]).catch(() => undefined);
      const waiting = resolver.resolve('second', [PARAMS]);
      const outcome = waiting.then(
        () => 'resolved',
        (error: unknown) => (error as { kind?: string }).kind,
      );
      await flush();
      resolver.clear();
      expect(await outcome).toBe('aborted');
      expect(resolver.peek('first')).toBeUndefined();
    });
  });

  it('keeps a bounded number of pictures, dropping the least recently used', async () => {
    const { daemon, resolver } = setup({ maxEntries: 2 });
    daemon.reply('getAvatar', { data: JPEG });
    await resolver.resolve('a', [PARAMS]);
    await resolver.resolve('b', [PARAMS]);
    await resolver.resolve('a', [PARAMS]); // a is now the most recent
    await resolver.resolve('c', [PARAMS]);
    expect(resolver.peek('a')).toBeDefined();
    expect(resolver.peek('b')).toBeUndefined();
    expect(resolver.peek('c')).toBeDefined();
  });
});
