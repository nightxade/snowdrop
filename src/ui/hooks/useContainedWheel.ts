import type { RefCallback } from 'react';

/** Pixels a "line" wheel step scrolls when the element's line height can't be read. */
const FALLBACK_LINE = 16;

const canScrollY = (el: HTMLElement): boolean => {
  if (el.scrollHeight <= el.clientHeight) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
};

/** The nearest vertically scrollable element from `from` up to `root`, both included. */
function scrollerBetween(from: Element | null, root: HTMLElement): HTMLElement | null {
  for (let el = from; el; el = el.parentElement) {
    if (el instanceof HTMLElement && canScrollY(el)) return el;
    if (el === root) break;
  }
  return null;
}

/** A wheel step's vertical distance in px. */
function wheelPixels(e: WheelEvent, el: HTMLElement): number {
  if (e.deltaMode === 1) {
    const line = parseFloat(getComputedStyle(el).lineHeight);
    return e.deltaY * (Number.isFinite(line) ? line : FALLBACK_LINE);
  }
  if (e.deltaMode === 2) return e.deltaY * el.clientHeight;
  return e.deltaY;
}

function contain(this: HTMLElement, e: WheelEvent): void {
  // A pinch zoom (ctrl + wheel) and a mostly sideways gesture are not ours.
  if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  if (!(e.target instanceof Element) || !this.contains(e.target)) return;
  const scroller = scrollerBetween(e.target, this);
  // The page behind never scrolls from a wheel over this element, even at the scroller's end or with
  // nothing to scroll (what `overscroll-behavior: contain` says, which a threaded scroll can bypass).
  e.preventDefault();
  if (scroller) scroller.scrollTop += wheelPixels(e, scroller);
}

/** Ref callback: listens while the element is mounted (React 19 runs the returned cleanup on unmount). */
function attach(el: HTMLElement): () => void {
  el.addEventListener('wheel', contain, { passive: false });
  return () => {
    el.removeEventListener('wheel', contain);
  };
}

/**
 * Keeps the wheel inside a popover or picker: the element's own scrollable area scrolls and nothing
 * behind it does. WebKit's threaded scrolling can hand a wheel over a floating surface to the scroller
 * underneath it (the chat behind the sticker picker scrolled, the picker did not), and `overscroll-
 * behavior` does not stop that; a non-passive `wheel` listener makes the event reach the main thread
 * first, where it is handled here. Mouse-wheel steps jump instead of animating.
 *
 * Returns a ref callback, not a ref object: the element mounts late, in a portal. The callback is the
 * same for every element, so one can serve several (submenus).
 */
export function useContainedWheel(): RefCallback<HTMLElement> {
  return attach;
}
