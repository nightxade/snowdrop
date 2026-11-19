import { useEffect, useLayoutEffect, useRef } from 'react';
import { focusQuietly } from '@/ui/primitives/focusQuietly';
import { fallbackFocus } from '@/ui/primitives/openerFocus';

/**
 * The row that takes focus when the focused one leaves a list: the next one that is still
 * there, else the nearest before it. `previous` is the order before the change, `current` the
 * order now.
 */
export function neighbourOf<T>(
  previous: readonly T[],
  current: readonly T[],
  gone: T,
  usable: (id: T) => boolean = () => true,
): T | undefined {
  const at = previous.indexOf(gone);
  if (at === -1) return undefined;
  const there = new Set(current);
  const ok = (id: T | undefined): id is T => id !== undefined && there.has(id) && usable(id);
  for (let i = at + 1; i < previous.length; i += 1) if (ok(previous[i])) return previous[i];
  for (let i = at - 1; i >= 0; i -= 1) if (ok(previous[i])) return previous[i];
  return undefined;
}

/** Focus has been lost: it fell to the page, or sits on something that is no longer shown. */
export function focusLost(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return true;
  return !active.isConnected || active.getClientRects().length === 0;
}

export interface HandOffWhenGone {
  /** Which thing of this surface (a row, a pane) the focused element belongs to; null when none. */
  identify: (el: Element) => string | null;
  /** Whether that thing is still on offer after this render. */
  stillThere: (id: string) => boolean;
  /** Where focus goes instead; nothing means the shared fallback (`fallbackFocus`, never the page). */
  replacement?: (gone: string) => HTMLElement | null | undefined;
  /** A change of scope (another space, another list) is not a removal: what was focused is forgotten. */
  scope?: string;
}

/**
 * Focus never falls to the page when the thing that had it goes: a row removed (archived, deleted
 * on the phone, a member removed), a pane that left (the layout narrowed, the chat was deleted).
 * After the render in which it is no longer there, and only while focus is lost, it goes to
 * `replacement(gone)`, else the shared fallback. Focus the user put elsewhere is never taken.
 */
export function useHandOffWhenGone(options: HandOffWhenGone): void {
  const latest = useRef(options);
  const focused = useRef<string | null>(null);
  const scope = useRef(options.scope);
  useLayoutEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focused.current =
        event.target instanceof Element ? latest.current.identify(event.target) : null;
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (scope.current !== options.scope) {
      scope.current = options.scope;
      focused.current = null;
      return;
    }
    const gone = focused.current;
    if (gone === null || options.stillThere(gone)) return;
    if (!focusLost()) return;
    focused.current = null;
    const target = options.replacement?.(gone) ?? fallbackFocus();
    if (target?.isConnected) focusQuietly(target);
  });
}

export interface HandOffRow {
  /** The ids of the rows shown, in order. */
  ids: readonly string[];
  /** Which row (id) an element belongs to; null when it is not one of this list's. */
  identify: (el: Element) => string | null;
  /** The element to focus for a row, when it is rendered. */
  find: (id: string) => HTMLElement | null | undefined;
  /** The list's own tab stop, for when no row is left. */
  tabStop?: () => HTMLElement | null | undefined;
  scope?: string;
}

/**
 * A focused row that disappears hands focus to its neighbour: the next row in the same list,
 * else the previous, else the list's own tab stop, else the shared fallback (the composer).
 */
export function useHandOffRow({ ids, identify, find, tabStop, scope }: HandOffRow): void {
  const previous = useRef(ids);
  const there = new Set(ids);
  useHandOffWhenGone({
    identify,
    stillThere: (id) => there.has(id),
    replacement: (gone) => {
      const next = neighbourOf(previous.current, ids, gone, (id) => !!find(id));
      return (next === undefined ? undefined : find(next)) ?? tabStop?.();
    },
    ...(scope === undefined ? {} : { scope }),
  });
  useLayoutEffect(() => {
    previous.current = ids;
  });
}
