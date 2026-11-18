import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useStores } from './SnowdropContext';

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

/**
 * Every layout breakpoint, in layout px: the widest page width (inclusive) at which "below" holds.
 * Keyed by the number the stylesheets name it by (`data-below-760`); the odd limits (759.98, 639.98)
 * are "width < 760" written as a max-width, the round ones (600, 520, 380) are plain max-widths.
 */
const CSS_LIMITS = {
  380: 380,
  480: 479.98,
  520: 520,
  600: 600,
  640: 639.98,
  760: 759.98,
  1100: 1099.98,
} as const;

/** Layout breakpoints from PLAN §4.1, in layout px: window px divided by the Zoom setting. */
const BREAKPOINT_LIMITS = {
  /** Member list becomes an overlay sheet below this width. */
  members: CSS_LIMITS[1100],
  /** Rail + sidebar collapse into a drawer below this width. */
  drawer: CSS_LIMITS[760],
} as const;

export type Breakpoint = keyof typeof BREAKPOINT_LIMITS;

const windowLimit = (limit: number, zoom: number): string =>
  `(max-width: ${Math.round(limit * zoom * 100) / 100}px)`;

/**
 * The media query for "narrower than the breakpoint" at a zoom. Zoom is a CSS zoom on the page, which
 * media queries don't see (they measure the window): at 150% the page is laid out in a window a
 * third narrower, so the window-pixel limit is the layout limit times the zoom. The stylesheets
 * ask the same question through `data-below-*` on the root (`useBreakpointAttributes`).
 */
export function belowBreakpoint(name: Breakpoint, zoom = 1): string {
  return windowLimit(BREAKPOINT_LIMITS[name], zoom);
}

/** The root attribute a stylesheet selects on for a breakpoint: `:root[data-below-760]`. */
export const belowAttribute = (limit: keyof typeof CSS_LIMITS): string => `data-below-${limit}`;

/**
 * Mirrors every breakpoint onto the document element as `data-below-<limit>` (present while the page,
 * at the Zoom setting, is that narrow). The stylesheets select on these instead of `@media`, which
 * ignores Zoom, and instead of `@container`, whose container on an ancestor of the message list
 * changes how it lays out. Mount once, high in the tree.
 */
export function useBreakpointAttributes(): void {
  const stores = useStores();
  const zoom = useStore(stores.settings, (s) => s.appearance.zoom);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const root = document.documentElement;
    const stops: Array<() => void> = [];
    for (const [key, limit] of Object.entries(CSS_LIMITS)) {
      const attribute = belowAttribute(Number(key) as keyof typeof CSS_LIMITS);
      const query = windowLimit(limit, zoom);
      const apply = () => {
        if (currentMatches(query)) root.setAttribute(attribute, '');
        else root.removeAttribute(attribute);
      };
      stops.push(subscribeTo(query, apply));
      apply();
    }
    return () => {
      for (const stop of stops) stop();
      for (const key of Object.keys(CSS_LIMITS)) {
        root.removeAttribute(belowAttribute(Number(key) as keyof typeof CSS_LIMITS));
      }
    };
  }, [zoom]);
}

/** Whether the layout is narrower than a breakpoint (also true when `or` matches, e.g. a touch screen). */
export function useBelowBreakpoint(name: Breakpoint, or?: string): boolean {
  const stores = useStores();
  const zoom = useStore(stores.settings, (s) => s.appearance.zoom);
  const below = belowBreakpoint(name, zoom);
  return useMediaQuery(or ? `${or}, ${below}` : below);
}
