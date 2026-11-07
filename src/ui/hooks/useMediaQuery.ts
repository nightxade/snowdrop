import { useCallback, useSyncExternalStore } from 'react';

/**
 * One `MediaQueryList` and one change listener per query, however many
 * components ask (every message row asks), instead of a list and a listener
 * each. Dropped when the last subscriber leaves; rebuilt if `window.matchMedia`
 * itself is replaced (tests do that to stage a layout).
 */
interface Shared {
  /** The `window.matchMedia` this was made with. */
  match: unknown;
  list: MediaQueryList;
  listeners: Set<() => void>;
  notify: () => void;
}

const shared = new Map<string, Shared>();

/** `window.matchMedia` as a value to compare (it is only ever called on `window`). */
const currentMatcher = (): unknown => Reflect.get(window, 'matchMedia');

function sharedFor(query: string): Shared {
  const existing = shared.get(query);
  if (existing && existing.match === currentMatcher()) return existing;
  const next: Shared = {
    match: currentMatcher(),
    list: window.matchMedia(query),
    listeners: existing?.listeners ?? new Set(),
    notify: () => {
      for (const listener of next.listeners) listener();
    },
  };
  if (existing) existing.list.removeEventListener('change', existing.notify);
  if (next.listeners.size > 0) next.list.addEventListener('change', next.notify);
  shared.set(query, next);
  return next;
}

/** The answer now: from the shared list when someone subscribes, else asked fresh (nothing is cached). */
function currentMatches(query: string): boolean {
  const existing = shared.get(query);
  if (existing && existing.match === currentMatcher()) return existing.list.matches;
  return window.matchMedia(query).matches;
}

function subscribeTo(query: string, listener: () => void): () => void {
  const entry = sharedFor(query);
  if (entry.listeners.size === 0) entry.list.addEventListener('change', entry.notify);
  entry.listeners.add(listener);
  return () => {
    const current = shared.get(query);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.list.removeEventListener('change', current.notify);
      shared.delete(query);
    }
  };
}

/** How many queries are held (for tests: a render that never subscribes must leave none). */
export const sharedQueryCount = (): number => shared.size;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => subscribeTo(query, listener), [query]);
  return useSyncExternalStore(
    subscribe,
    () => currentMatches(query),
    () => false,
  );
}

/** Layout breakpoints from PLAN §4.1. */
export const BREAKPOINTS = {
  /** Member list becomes an overlay sheet below this width. */
  members: '(max-width: 1099.98px)',
  /** Rail + sidebar collapse into a drawer below this width. */
  drawer: '(max-width: 759.98px)',
} as const;
