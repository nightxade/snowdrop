import type { FocusTarget, KeyLayerContext, TextSurface } from '@/core/commands';

/**
 * Text fields that key layers may drive (the composer registers itself), keyed
 * by their element so the keyboard listener can find the focused one.
 */
const surfaces = new WeakMap<Element, TextSurface>();

/** Registers a field; returns an unregister function. */
export function registerTextSurface(element: Element, surface: TextSurface): () => void {
  surfaces.set(element, surface);
  return () => {
    if (surfaces.get(element) === surface) surfaces.delete(element);
  };
}

export function textSurfaceFor(element: Element | null): TextSurface | null {
  return element ? (surfaces.get(element) ?? null) : null;
}

function isTextField(el: Element): boolean {
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return (
    el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type)
  );
}

const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * Where focus is and whether something modal owns the keyboard, for key
 * layers. The composer's own suggestion list counts as an overlay, so its
 * Escape and arrows keep working in Vim's Insert mode.
 */
export function describeFocus(doc: Document, modalOpen: boolean): KeyLayerContext {
  const active = doc.activeElement;
  const overlay = modalOpen || doc.querySelector(OVERLAY) !== null;
  let target: FocusTarget = 'other';
  let surface: TextSurface | null = null;
  if (!active || active === doc.body || active === doc.documentElement) target = 'none';
  else if ((surface = textSurfaceFor(active))) target = 'composer';
  else if (isTextField(active)) target = 'input';
  else if (active.hasAttribute('data-message-id') && active.hasAttribute('data-roving-item'))
    target = 'message';
  else if (active.hasAttribute('data-message-scroller')) target = 'list';
  return { target, overlay, surface };
}
