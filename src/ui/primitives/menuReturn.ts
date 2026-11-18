/**
 * Where focus belongs after a dialog that a menu item opened. The item is
 * gone by the time the dialog closes, so a dialog must not remember it as its
 * opener: it remembers what the menu itself was opened from instead (the
 * message row or the button), which is also where Radix puts focus when a menu
 * closes without a dialog.
 */
const MENU = '[role="menu"]';

/** What had focus when the latest menu opened (only one menu is open at a time). */
let opened: HTMLElement | null = null;

/**
 * A menu is opening: remember what had focus or, failing that, its trigger. Always replaces the
 * previous menu's opener, so a dialog never returns focus to an older menu's.
 */
export function rememberMenuOpener(fallback?: HTMLElement | null): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  opened =
    active instanceof HTMLElement && active !== document.body && !active.closest(MENU)
      ? active
      : (fallback ?? null);
}

/**
 * The element a dialog opened while `focused` had focus should hand focus
 * back to: `focused` itself, unless it sits inside a menu, in which case the
 * element that opened that menu.
 */
export function resolveOpener(focused: HTMLElement | null): HTMLElement | null {
  if (!focused) return null;
  const menu = focused.closest<HTMLElement>(MENU);
  if (!menu) return focused;
  // A dropdown menu names its trigger; a context menu has none, so use what the menu recorded.
  const labelledBy = menu.getAttribute('aria-labelledby');
  const trigger = labelledBy ? document.getElementById(labelledBy) : null;
  const target =
    (trigger && !trigger.closest(MENU) ? trigger : null) ?? (opened?.isConnected ? opened : null);
  return target;
}

/** A menu closed: what it was opened from is no longer a place to return to from some later dialog. */
export function forgetMenuOpener(): void {
  opened = null;
}

/** The element the latest menu was opened from, if it is still on the page. */
export function rememberedMenuOpener(): HTMLElement | null {
  return opened?.isConnected ? opened : null;
}

/** For tests. */
export function resetMenuOpeners(): void {
  opened = null;
}
