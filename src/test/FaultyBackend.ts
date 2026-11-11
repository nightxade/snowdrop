/**
 * A decorator over any `ChatBackend` that makes the slow, flaky and
 * out-of-order cases reproducible in app-level tests:
 *
 * - `failFirst`: the first call to each listed method rejects (as an
 *   unreachable transport by default), later calls go through;
 * - `delay`: a listed method waits that many ms on the injected scheduler
 *   before it calls the real backend (advance a `ManualScheduler` to release it);
 * - `holdEvent`: events of the listed kinds are kept back instead of delivered,
 *   in order, until `release(event)` hands them over (`caughtUp` arriving late,
 *   or behind messages the test delivers meanwhile).
 *
 * Everything else, including `capabilities`, `kind` and the synchronous
 * members, is the real backend's own, so it passes `deferredBackend`'s parity
 * and contract checks unchanged.
 */
import type { BackendEvents, ChatBackend } from '@/core/backend';
import { AppError, type Scheduler } from '@/core/lib';

type Method = keyof ChatBackend;
type EventName = keyof BackendEvents;

export interface FaultyOptions {
  failFirst?: readonly Method[];
  /** The failure `failFirst` throws; defaults to a transient `unreachable` that sent nothing. */
  error?: (method: Method) => Error;
  /** Milliseconds each listed method waits first; needs `scheduler`. */
  delay?: Partial<Record<Method, number>>;
  scheduler?: Scheduler;
  holdEvent?: readonly EventName[];
}

export interface FaultyControls {
  /** Delivers what was held for `event` (in order), and stops holding it. */
  release: (event: EventName) => void;
  /** How many events of this kind are waiting. */
  held: (event: EventName) => number;
  /** How many times the method was called through this decorator. */
  calls: (method: Method) => number;
}

export type FaultyBackend = ChatBackend & FaultyControls;

interface Held {
  hold: boolean;
  queue: unknown[];
  handlers: Set<(payload: never) => void>;
}

export function faultyBackend(inner: ChatBackend, options: FaultyOptions = {}): FaultyBackend {
  const failFirst = new Set<Method>(options.failFirst);
  const callCounts = new Map<Method, number>();
  const held = new Map<EventName, Held>();
  for (const event of options.holdEvent ?? [])
    held.set(event, { hold: true, queue: [], handlers: new Set() });
  if (options.delay && !options.scheduler)
    throw new Error('FaultyBackend: `delay` needs a `scheduler`');

  const fail =
    options.error ??
    ((method: Method): Error =>
      new AppError('unreachable', `Simulated failure of ${method}`, {
        transient: true,
        outcome: 'not-sent',
      }));

  const controls: FaultyControls = {
    release(event) {
      const entry = held.get(event);
      if (!entry) return;
      entry.hold = false;
      for (const payload of entry.queue.splice(0))
        for (const fn of [...entry.handlers]) fn(payload as never);
    },
    held: (event) => held.get(event)?.queue.length ?? 0,
    calls: (method) => callCounts.get(method) ?? 0,
  };

  const subscribe = ((event: EventName, fn: (payload: never) => void) => {
    const entry = held.get(event);
    if (!entry) return inner.on(event, fn as never);
    entry.handlers.add(fn);
    // One subscription to the real backend per handler; each decides whether to hold.
    const off = inner.on(event, (payload: unknown) => {
      if (entry.hold) {
        // Queue once per payload, not once per handler.
        if (entry.handlers.size === 0 || [...entry.handlers][0] === fn) entry.queue.push(payload);
      } else fn(payload as never);
    });
    return () => {
      entry.handlers.delete(fn);
      off();
    };
  }) as ChatBackend['on'];

  return new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in controls)
        return controls[prop as keyof FaultyControls];
      if (prop === 'on') return subscribe;
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      const method = prop as Method;
      const call = (...args: unknown[]): unknown =>
        Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      const delayMs = options.delay?.[method];
      if (!failFirst.has(method) && delayMs === undefined) {
        return (...args: unknown[]): unknown => {
          callCounts.set(method, controls.calls(method) + 1);
          return call(...args);
        };
      }
      return async (...args: unknown[]): Promise<unknown> => {
        const nth = controls.calls(method);
        callCounts.set(method, nth + 1);
        if (delayMs !== undefined && options.scheduler) {
          const scheduler = options.scheduler;
          await new Promise<void>((resolve) => {
            scheduler.setTimeout(resolve, delayMs);
          });
        }
        if (failFirst.has(method) && nth === 0) throw fail(method);
        return call(...args);
      };
    },
  }) as FaultyBackend;
}
