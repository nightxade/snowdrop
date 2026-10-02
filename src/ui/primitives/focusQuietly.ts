/**
 * Programmatic focus (restoring focus after a dialog closes, say) shouldn't
 * pop the target's tooltip as if the user had tabbed to it. Tooltip skips
 * opening for a focus event on an element marked this way.
 */
export const QUIET_FOCUS = 'data-quiet-focus';

export function focusQuietly(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.setAttribute(QUIET_FOCUS, '');
  el.focus();
  // Focus events fire synchronously; drop the mark right after.
  setTimeout(() => {
    el.removeAttribute(QUIET_FOCUS);
  }, 0);
}
