/**
 * Plugin-local reactive state: a tiny observable value, so a plugin's UI
 * (decorations, accessories) can follow state the plugin owns without a
 * hand-rolled listener set. The ui/ layer reads it with `usePluginState`.
 */
import type { Disposer } from '@/core/lib';

export interface PluginState<T> {
  get(): T;
  /** Replaces the value (or derives it from the previous one); same value = no notification. */
  set(next: T | ((previous: T) => T)): void;
  /** Called with the new value after each change. */
  subscribe(fn: (value: T) => void): Disposer;
}

/**
 * Creates a state cell. `onError` receives listener failures (one bad
 * listener doesn't stop the others). Note: a function `T` must be set through
 * the updater form, since a bare function is taken as an updater.
 */
export function createPluginState<T>(
  initial: T,
  onError: (error: unknown) => void,
): PluginState<T> & { clear(): void } {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const fn of [...listeners]) {
        try {
          fn(value);
        } catch (error) {
          onError(error);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}
