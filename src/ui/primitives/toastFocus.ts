import { useEffect } from 'react';
import { focusQuietly } from './focusQuietly';
import { fallbackFocus } from './openerFocus';

const LIST = '[data-sonner-toaster]';
const TOAST = '[data-sonner-toast]';

function inToasts(el: unknown): el is HTMLElement {
  return el instanceof HTMLElement && el.closest(LIST) !== null;
}

/** The toasts on screen, in order, not counting one that is on its way out. */
function shownToasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`${LIST} ${TOAST}`)].filter(
    (t) => t.dataset.removed !== 'true',
  );
}

function focusFell(): boolean {
  const active = document.activeElement;
  return !(active instanceof HTMLElement) || active === document.body || !active.isConnected;
}

/**
 * Focus in the toast list (Alt+T moves it there; sonner's own hotkey) never gets lost or stuck:
 * Esc returns it to where it was before, and when the focused toast goes (it expired, or was
 * dismissed) it moves to the next toast, else back to where it was before, never the page.
 * "Where it was before" is the last element focused outside the list, else the shared fallback
 * (`fallbackFocus`). Focus that leaves the list any other way (a shortcut opened a dialog, a
 * click, Shift+Tab) stays where it went: sonner would give the element from before Alt+T focus
 * back whatever took it, so it is never told where that was (its focus-in sees no related target).
 */
export function useToastFocus(): void {
  useEffect(() => {
    let outside: HTMLElement | null = null;
    let origin: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let at = -1;
    let watch: MutationObserver | null = null;

    const leave = (): void => {
      watch?.disconnect();
      watch = null;
      focused = null;
      const target = origin?.isConnected ? origin : fallbackFocus();
      origin = null;
      focusQuietly(target);
    };
    const onChange = (): void => {
      if (!focused || focused.isConnected || !focusFell()) return;
      const next = at >= 0 ? shownToasts()[at] : undefined;
      if (next) focusQuietly(next);
      else leave();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const { target } = event;
      if (inToasts(target)) {
        // Sonner remembers `relatedTarget` to refocus on blur; with none it leaves focus alone.
        Object.defineProperty(event, 'relatedTarget', { value: null, configurable: true });
        if (!watch) {
          origin = outside?.isConnected ? outside : null;
          watch = new MutationObserver(onChange);
          watch.observe(document.body, { childList: true, subtree: true });
        }
        focused = target;
        const toast = target.closest<HTMLElement>(TOAST);
        at = toast ? shownToasts().indexOf(toast) : -1;
        return;
      }
      watch?.disconnect();
      watch = null;
      focused = null;
      origin = null;
      if (target instanceof HTMLElement && target !== document.body) outside = target;
    };
    const onFocusOut = (event: FocusEvent): void => {
      // Focus went nowhere (the page): that is what Alt+T would leave from.
      if (!inToasts(event.target) && !(event.relatedTarget instanceof HTMLElement)) outside = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !inToasts(document.activeElement)) return;
      // After sonner's own Esc (it collapses the list) and whatever else handles the key.
      setTimeout(() => {
        if (inToasts(document.activeElement)) leave();
      }, 0);
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKeyDown);
      watch?.disconnect();
    };
  }, []);
}
