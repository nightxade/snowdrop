import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * For a panel that can be closed by something other than its own controls (a shortcut, a
 * command): when it goes away while focus is inside the element matching `within`, `handOff`
 * puts focus somewhere useful, instead of it dropping to the page. Runs before the panel's
 * elements leave the page; focus that is anywhere else is left alone.
 */
export function useHandOffFocus(within: string, handOff: () => void, enabled = true): void {
  const latest = useRef(handOff);
  useEffect(() => {
    latest.current = handOff;
  });
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return () => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest(within)) latest.current();
    };
  }, [within, enabled]);
}
