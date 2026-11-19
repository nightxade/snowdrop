import { useEffect, useLayoutEffect, useRef } from 'react';
import { focusQuietly } from '@/ui/primitives/focusQuietly';
import { resolveOpener } from '@/ui/primitives/menuReturn';
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
  /**
   * Where the thing is now when it is still on offer but the element that had focus was replaced
   * (a tile that remounts in another parent, a row filed under another heading); focus follows it.
   */
  again?: (id: string) => HTMLElement | null | undefined;
  /** A change of scope (another space, another list) is not a removal: what was focused is forgotten. */
  scope?: string;
}

const MENU = '[role="menu"]';
/** Frames to wait for a menu that is closing (its item, which had focus, is still on the page). */
const MENU_FRAMES = 60;

/**
 * Focus never falls to the page when the thing that had it goes: a row removed (archived, deleted
 * on the phone, a member removed), a pane that left (the layout narrowed, the chat was deleted).
 * After the render in which it is no longer there, and only while focus is lost, it goes to
 * `replacement(gone)`, else the shared fallback. Focus the user put elsewhere is never taken.
 *
 * Focus inside a menu opened from the thing counts as being on the thing (`resolveOpener`): the
 * hand-off waits for the menu to close, then acts if focus fell to the page. A thing that stays but
 * whose element was replaced gets focus back on its new element (`again`).
 */
export function useHandOffWhenGone(options: HandOffWhenGone): void {
  const latest = useRef(options);
  const focused = useRef<{ id: string; el: Element } | null>(null);
  const waiting = useRef<number | null>(null);
  /** Where focus is to go for what was focused, worked out when it was first seen to be gone. */
  const decided = useRef<{ of: object; next: HTMLElement | null | undefined } | null>(null);
  const scope = useRef(options.scope);
  const stopWaiting = () => {
    if (waiting.current !== null) cancelAnimationFrame(waiting.current);
    waiting.current = null;
  };
  useLayoutEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      const place = target instanceof HTMLElement ? resolveOpener(target) : null;
      const id = place ? latest.current.identify(place) : null;
      focused.current = place && id !== null ? { id, el: place } : null;
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (event.relatedTarget !== null || !(target instanceof Element)) return;
      // The user clicked away, off anything focusable: what they left is not theirs to be handed back.
      setTimeout(() => {
        if (
          document.activeElement === document.body &&
          target.isConnected &&
          focused.current?.el === target
        )
          focused.current = null;
      }, 0);
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      stopWaiting();
    };
  }, []);
  useLayoutEffect(() => {
    if (scope.current !== options.scope) {
      scope.current = options.scope;
      focused.current = null;
      stopWaiting();
      return;
    }
    const current = focused.current;
    if (current === null) return;
    const there = options.stillThere(current.id);
    if (there && current.el.isConnected) return;
    // Worked out once (the render that follows may no longer know what the list was before).
    if (decided.current?.of !== current)
      decided.current = {
        of: current,
        next: there ? options.again?.(current.id) : options.replacement?.(current.id),
      };
    const { next } = decided.current;
    if (there && !next) return;
    // Moving within the thing's menu (a new focusin on another item) is still focus on the thing.
    const stillOn = () => focused.current?.id === current.id;
    const finish = () => {
      if (!stillOn()) return;
      focused.current = null;
      const target = next?.isConnected ? next : there ? undefined : fallbackFocus();
      if (target?.isConnected) focusQuietly(target);
    };
    if (focusLost()) {
      stopWaiting();
      finish();
      return;
    }
    if (waiting.current !== null || !document.activeElement?.closest(MENU)) return;
    // The item that was chosen still has focus while its menu closes: act once the menu is gone.
    let frames = 0;
    const wait = () => {
      waiting.current = null;
      if (!stillOn() || (frames += 1) > MENU_FRAMES) return;
      if (document.querySelector(MENU)) {
        waiting.current = requestAnimationFrame(wait);
        return;
      }
      if (focusLost()) finish();
      else focused.current = null;
    };
    waiting.current = requestAnimationFrame(wait);
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
    // A row that stays but is mounted anew (filed under another heading) gets its focus back.
    again: find,
    ...(scope === undefined ? {} : { scope }),
  });
  useLayoutEffect(() => {
    previous.current = ids;
  });
}
