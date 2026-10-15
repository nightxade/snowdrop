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

/**
 * Whether a text field has something its own Escape would still clear —
 * the same condition SearchInput's "Escape clears first, then bubbles"
 * checks before it acts. No per-component hook: just the field's value (or,
 * for a contenteditable, its text), the one generic signal every text field
 * already exposes.
 */
function hasEscapableValue(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== '';
  if (el instanceof HTMLElement && el.isContentEditable) return el.textContent !== '';
  return false;
}

const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
/** Open modal layers that own the keyboard even if focus hasn't moved into them yet. */
const TOP_LAYER =
  '[aria-modal="true"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"]';

/**
 * Whether a dialog, menu or listbox owns the keyboard right now: one that
 * contains focus, one the focused field controls, or an open modal/menu
 * focus hasn't reached yet. Persistent listboxes elsewhere don't count.
 */
export function overlayOwnsKeys(
  doc: Document,
  active: Element | null = doc.activeElement,
): boolean {
  if (active && active !== doc.body) {
    // Focus inside one (a menu, the switcher's list, a dialog, the nav drawer).
    if (active.closest(OVERLAY)) return true;
    // A popup the focused field controls (the composer's suggestions).
    for (const attr of ['aria-controls', 'aria-owns', 'aria-activedescendant']) {
      for (const id of (active.getAttribute(attr) ?? '').split(/\s+/u)) {
        const el = id ? doc.getElementById(id) : null;
        if (el?.closest(OVERLAY)) return true;
      }
    }
  }
  // A modal or open menu whose focus hasn't landed yet. Persistent listboxes
  // elsewhere on the page (a sidebar list, a closed drawer) don't count.
  return doc.querySelector(TOP_LAYER) !== null;
}

/**
 * Where focus is and whether something modal owns the keyboard, for key
 * layers. Only overlays that contain focus, that the focused field controls
 * (the composer's suggestion list, so its Escape and arrows keep working in
 * Vim's Insert mode) or that are open modals count.
 */
export function describeFocus(doc: Document, modalOpen: boolean): KeyLayerContext {
  const active = doc.activeElement;
  const overlay = modalOpen || overlayOwnsKeys(doc, active);
  let target: FocusTarget = 'other';
  let surface: TextSurface | null = null;
  if (!active || active === doc.body || active === doc.documentElement) target = 'none';
  else if ((surface = textSurfaceFor(active))) target = 'composer';
  else if (isTextField(active)) target = 'input';
  else if (active.hasAttribute('data-message-id') && active.hasAttribute('data-roving-item'))
    target = 'message';
  else if (active.hasAttribute('data-message-scroller')) target = 'list';
  return {
    target,
    overlay,
    surface,
    ...(target === 'input' && active ? { inputHasValue: hasEscapableValue(active) } : {}),
  };
}
