import { useCallback, type KeyboardEvent } from 'react';

export type RovingOrientation = 'vertical' | 'horizontal';

const ITEM = '[data-roving-item]:not([data-roving-disabled])';

/**
 * Arrow-key navigation within a list (WAI-ARIA "roving tabindex" without the
 * bookkeeping): items carry `data-roving-item`; the one to tab into carries
 * `tabIndex={0}` and the rest `-1`. Home/End jump to the ends. Items hidden
 * inside collapsed groups simply aren't rendered, so they're skipped.
 */
export function useRovingFocus(orientation: RovingOrientation = 'vertical') {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
      const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // React bubbles events from portals (menus, popovers) through the
      // component tree; only handle keys pressed on the list's own DOM.
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      if (![prevKey, nextKey, 'Home', 'End'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)];
      if (items.length === 0) return;
      const current = items.findIndex((el) => el === document.activeElement);
      let next: number;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (current === -1) next = 0;
      else next = event.key === nextKey ? current + 1 : current - 1;
      const target = items[Math.max(0, Math.min(items.length - 1, next))];
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    },
    [orientation],
  );
}
