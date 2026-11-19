const CONTROLS =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** A control that asks to be where focus goes when a neighbour in its row goes. */
const ANCHOR = '[data-focus-anchor]';

/** What was focused on a settings page, and what surrounded it at the time. */
export interface FocusSnapshot {
  el: HTMLElement;
  /** Its ancestors up to the page, nearest first. */
  chain: HTMLElement[];
  /** Every control on the page, in DOM order. */
  controls: HTMLElement[];
}

const kindOf = (el: Element): string => el.getAttribute('role') ?? el.tagName.toLowerCase();

/**
 * The control focus goes to when the focused one left the page: the nearest one that stays, found
 * in the closest ancestor that still holds one (the row, the card, the field), preferring a
 * control marked as the row's anchor, then one of the same kind (a button for a button), then the
 * closest in DOM order, the one before on a tie. Null when nothing stays near it.
 */
export function nearestControl(snapshot: FocusSnapshot): HTMLElement | null {
  const { el, chain, controls } = snapshot;
  const at = controls.indexOf(el);
  for (const ancestor of chain) {
    if (!ancestor.isConnected) continue;
    const here = controls
      .map((control, index) => ({ control, index }))
      .filter(
        ({ control }) =>
          control !== el &&
          control.isConnected &&
          ancestor.contains(control) &&
          control.getClientRects().length > 0,
      );
    if (here.length === 0) continue;
    const anchored = here.filter(({ control }) => control.matches(ANCHOR));
    const sameKind = here.filter(({ control }) => kindOf(control) === kindOf(el));
    const pool = anchored.length > 0 ? anchored : sameKind.length > 0 ? sameKind : here;
    let best = pool[0];
    for (const candidate of pool) {
      if (!best) break;
      const d = Math.abs(candidate.index - at);
      const bestD = Math.abs(best.index - at);
      if (d < bestD || (d === bestD && candidate.index < best.index)) best = candidate;
    }
    if (best) return best.control;
  }
  return null;
}

/**
 * Focus inside a settings page never falls to the dialog when the control that had it goes (a
 * "Reset to default" that has nothing left to reset, Reassign / Cancel in the conflict prompt,
 * "Remove emoji", a plugin card filtered away): it goes to the nearest control that stays
 * (`nearestControl`). Focus the user put elsewhere is never taken. Pass the result as the `ref` of
 * the element that holds the pages.
 */
export function keepFocusOnPage(page: HTMLElement | null): (() => void) | undefined {
  if (!page) return undefined;
  let snapshot: FocusSnapshot | null = null;
  const onFocusIn = (event: FocusEvent): void => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || !page.contains(el)) {
      snapshot = null;
      return;
    }
    const chain: HTMLElement[] = [];
    for (let p = el.parentElement; p && p !== page.parentElement; p = p.parentElement)
      chain.push(p);
    snapshot = { el, chain, controls: [...page.querySelectorAll<HTMLElement>(CONTROLS)] };
  };
  const observer = new MutationObserver(() => {
    const gone = snapshot;
    if (!gone || gone.el.isConnected) return;
    const active = document.activeElement;
    const lost =
      !(active instanceof HTMLElement) ||
      active === document.body ||
      !active.isConnected ||
      active === page.closest('[role="dialog"]');
    if (!lost) return;
    const next = nearestControl(gone);
    snapshot = null;
    if (next) next.focus({ preventScroll: true });
  });
  document.addEventListener('focusin', onFocusIn, true);
  observer.observe(page, { childList: true, subtree: true });
  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    observer.disconnect();
  };
}
