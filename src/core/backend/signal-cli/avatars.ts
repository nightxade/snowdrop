/**
 * Avatar pictures ⇄ the daemon.
 *
 * signal-cli keeps every avatar it has downloaded in its own data directory
 * and hands one back only as base64 over `getAvatar`. Nothing here writes a
 * picture to disk: the answer is turned into a `data:` URL and held in
 * memory, in a small LRU, so a rebuilt row or a second place showing the same
 * person costs nothing.
 *
 * The sidebar can show hundreds of people, so:
 *  - a reference is fetched only when something asks (the UI asks for the
 *    avatars actually on screen);
 *  - concurrent requests for one reference share one call;
 *  - at most `concurrency` `getAvatar` calls run at once, the rest wait (newest first,
 *    so a fast scroll is served for where it ended up);
 *  - "this person has no picture" is remembered for a while, so a row that
 *    remounts doesn't ask again.
 *
 * A reference whose picture may have changed (`invalidate`) is dropped, and
 * any request still in flight for it is not remembered.
 */
import { SignalCliError } from './errors';
import type { JsonRpcClient, RpcParams } from './rpc';
import { wireAttachmentData } from './wire';

/** Pictures kept at once (a typical avatar is 10–60 KB). */
export const AVATAR_CACHE_ENTRIES = 400;
/** `getAvatar` calls in flight at once. */
export const AVATAR_CONCURRENCY = 3;
/** How long "no picture" is trusted before asking again. */
export const AVATAR_MISS_TTL_MS = 5 * 60_000;
/** Refuse anything bigger than this (base64 characters); real avatars are at most a few hundred KB. */
const MAX_BASE64_CHARS = 4 * 1024 * 1024;

/**
 * Image types an avatar may be, sniffed from the file's own first bytes
 * (signal-cli stores avatars as files with no content type). Anything else,
 * SVG and HTML included, is not shown.
 */
export function sniffAvatarType(base64: string): string | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const at = (i: number) => head.charCodeAt(i);
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (head.length >= 4 && at(0) === 0x89 && head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.length >= 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** `getAvatar` answers "no avatar" and "no such person" as ordinary user errors. */
function isMissing(error: unknown): boolean {
  return (
    error instanceof SignalCliError && (error.kind === 'user' || error.kind === 'unregistered')
  );
}

type Entry = { url: string | null; at: number };

export interface AvatarResolverOptions {
  rpc: JsonRpcClient;
  maxEntries?: number;
  concurrency?: number;
  missTtlMs?: number;
  now?: () => number;
}

export class AvatarResolver {
  /** Insertion order = least recently used first. */
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  /** Bumped per key by `invalidate`: a download that started before is not remembered. */
  private readonly revisions = new Map<string, number>();
  private readonly waiting: { start: () => void; abort: () => void }[] = [];
  private running = 0;
  /** Bumped by `clear`: late results from a previous account are discarded. */
  private generation = 0;
  private readonly maxEntries: number;
  private readonly concurrency: number;
  private readonly missTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AvatarResolverOptions) {
    this.maxEntries = options.maxEntries ?? AVATAR_CACHE_ENTRIES;
    this.concurrency = options.concurrency ?? AVATAR_CONCURRENCY;
    this.missTtlMs = options.missTtlMs ?? AVATAR_MISS_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** What is known right now: a URL, `null` for "no picture", `undefined` for "not known". */
  peek(key: string): string | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.url === null && this.now() - entry.at >= this.missTtlMs) return undefined;
    return entry.url;
  }

  /**
   * The picture for `key`: from the cache, else from the first of `attempts`
   * (each a `getAvatar` selector, tried in order) that has one. `null` when
   * none has. A failure that isn't "no such avatar" (the daemon is down,
   * the call timed out) rejects and is not remembered.
   */
  resolve(key: string, attempts: readonly RpcParams[]): Promise<string | null> {
    const known = this.peek(key);
    if (known !== undefined) {
      this.touch(key);
      return Promise.resolve(known);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const revision = this.revisions.get(key) ?? 0;
    const promise = this.load(attempts)
      .then((url) => {
        if (generation === this.generation && revision === (this.revisions.get(key) ?? 0)) {
          this.remember(key, url);
        }
        return url;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Remembers a picture we already hold (one the user just set), or `null` for none. */
  prime(key: string, url: string | null): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.inFlight.delete(key);
    this.remember(key, url);
  }

  /** Forgets `key`: the next request asks the daemon again. */
  invalidate(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.inFlight.delete(key);
    this.cache.delete(key);
  }

  /** Forgets everything (disconnect, another account). */
  clear(): void {
    this.generation++;
    this.cache.clear();
    this.inFlight.clear();
    this.revisions.clear();
    for (const waiter of this.waiting.splice(0)) waiter.abort();
    this.running = 0;
  }

  private remember(key: string, url: string | null): void {
    this.cache.delete(key);
    this.cache.set(key, { url, at: this.now() });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(oldest);
    }
  }

  private touch(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /** One person's sources are tried back to back in a single slot. */
  private async load(attempts: readonly RpcParams[]): Promise<string | null> {
    const generation = this.generation;
    await this.acquire();
    try {
      for (const params of attempts) {
        const url = await this.fetchOne(params);
        if (url !== null) return url;
      }
      return null;
    } finally {
      // clear() reset the counters; a call from before it must not touch them.
      if (generation === this.generation) this.release();
    }
  }

  private async fetchOne(params: RpcParams): Promise<string | null> {
    try {
      const { data } = await this.options.rpc.call('getAvatar', params, wireAttachmentData, {
        timeoutMs: 60_000,
      });
      if (data.length > MAX_BASE64_CHARS) return null;
      const type = sniffAvatarType(data);
      return type ? `data:${type};base64,${data}` : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({
        start: () => {
          this.running++;
          resolve();
        },
        abort: () => {
          reject(new SignalCliError('aborted', 'Disconnected while loading an avatar'));
        },
      });
    });
  }

  /**
   * Hands the free slot to the newest waiter: what was asked for last is what
   * is on screen now, while older asks are likely for rows already scrolled past.
   */
  private release(): void {
    this.running--;
    this.waiting.pop()?.start();
  }
}
