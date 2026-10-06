/**
 * Minimal typed event emitter.
 *
 * Listener errors are isolated: one throwing subscriber (e.g. a plugin) must
 * never prevent other subscribers from seeing the event, and must never bubble
 * into the code that emitted it.
 */
import { createLogger } from './log';

export type Unsubscribe = () => void;

export type Listener<T> = (payload: T) => void;

/** `Events` maps event names to payload types, e.g. `{ status: Status; message: Message }`. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly onListenerError: (error: unknown) => void = reportError) {}

  on<E extends keyof Events>(event: E, fn: Listener<Events[E]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot so listeners may unsubscribe during dispatch.
    for (const fn of [...set] as Listener<Events[E]>[]) {
      try {
        fn(payload);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}

const log = createLogger('app');

function reportError(error: unknown): void {
  log.error('event listener failed', error);
}
