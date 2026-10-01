import { useSyncExternalStore } from 'react';

/**
 * "Now", ticking once a minute through one shared timer, so many rows can
 * show relative labels ("Today at…", countdowns) without an interval each.
 */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useMinuteClock(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}
