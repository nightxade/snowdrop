/**
 * A MessageRepository usable before its IndexedDB connection is open.
 *
 * `createSnowdrop` is synchronous (services are wired up front), but opening
 * IndexedDB is async. Every repository method already returns a promise, so
 * a proxy that awaits the real repository before forwarding each call is
 * transparent to callers — and keeps working as methods are added to the
 * interface. If opening fails, every call rejects with that error, which the
 * sync engine reports as a failed start (with retry).
 */
import type { MessageRepository } from '@/core/persistence';

export function deferredRepository(ready: Promise<MessageRepository>): MessageRepository {
  return deferredAsync(ready, 'MessageRepository');
}

/**
 * Forwards every method of `T` to the object `ready` resolves with, passing
 * all arguments through unchanged. `T` must have only async methods. Meant
 * for facades that are handed out before their implementation has loaded.
 */
export function deferredAsync<T extends object>(ready: Promise<T>, name: string): T {
  // Avoid an unhandled rejection before the first call observes it.
  ready.catch(() => undefined);
  return new Proxy({} as T, {
    get(_target, key) {
      // Never look like a thenable (await on the proxy itself must not hang).
      if (key === 'then') return undefined;
      return (...args: unknown[]): Promise<unknown> =>
        ready.then((target) => {
          const method: unknown = Reflect.get(target, key);
          if (typeof method !== 'function') {
            throw new TypeError(`${name} has no method ${String(key)}`);
          }
          return Reflect.apply(method, target, args) as unknown;
        });
    },
  });
}
