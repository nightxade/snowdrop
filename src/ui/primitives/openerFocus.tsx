import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { conversationFocusPolicyActive } from '@/ui/hooks/focusTargets';
import { focusQuietly } from './focusQuietly';
import { rememberedMenuOpener, resolveOpener } from './menuReturn';

/**
 * What the dialog host (`ModalHost`) gives the dialogs it shows. It owns the
 * opener of the whole chain: the element that was focused when the first
 * dialog was requested. Dialogs that replace each other (New message to New
 * group, Reset link and back) never become openers themselves, and only the
 * end of the chain returns focus.
 */
export interface OpenerHost {
  /** The element that opened the first dialog of the chain, if there was one and it is still there. */
  opener(): HTMLElement | null;
  /** True once no dialog is left, so a closing layer should hand focus back. */
  settled(): boolean;
  /** A dialog layer mounted; call the returned function when it goes away. */
  register(): () => void;
}

const HostContext = createContext<OpenerHost | null>(null);
export const OpenerHostProvider = HostContext.Provider;

/**
 * Wraps the content of a dialog layer: layers opened from inside another
 * one are their own chain, not part of the host's.
 */
export function OpenerReset({ children }: { children: ReactNode }) {
  return <HostContext.Provider value={null}>{children}</HostContext.Provider>;
}

function focusedElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  // A menu item is gone by the time its dialog closes: the menu's own opener it is.
  return el instanceof HTMLElement && el !== document.body ? resolveOpener(el) : null;
}

/** For `ModalHost`, which records the opener when a dialog is requested. */
export { focusedElement as currentOpener };

/** Recently focused elements, oldest first: where focus was before a menu, palette or dialog took it. */
let history: HTMLElement[] = [];

/** `ModalHost` calls this once: from then on `fallbackFocus` knows where focus has been. */
export function trackFocusHistory(): () => void {
  const onFocusIn = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || el === document.body) return;
    history = [...history.filter((x) => x !== el), el].slice(-12);
  };
  document.addEventListener('focusin', onFocusIn, true);
  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    history = [];
  };
}

const COMPOSER = '[data-snowdrop="composer-input"]';
const NAV_DRAWER = '[data-snowdrop="drawer"]';

/** The message list's own tab stop: its current row, else the scroller. */
export function messageListStop(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(
      '[data-message-scroller] [data-roving-item][tabindex="0"]',
    ) ?? document.querySelector<HTMLElement>('[data-message-scroller]')
  );
}

/**
 * The composer, else the message list: where focus goes when what had it at the bottom of the
 * chat (a request bar's button, the composer) is replaced. While a focus policy is active
 * (Vim's navigation keys) the list comes first, as the composer only its own keys reach (M11).
 */
export function composerOrMessageList(): HTMLElement | null {
  const composer = document.querySelector<HTMLElement>(COMPOSER);
  return conversationFocusPolicyActive()
    ? (messageListStop() ?? composer)
    : (composer ?? messageListStop());
}

/** The topmost open modal dialog (Settings, a confirmation), if any. */
function openModal(): HTMLElement | null {
  const open = document.querySelectorAll<HTMLElement>('[data-modal-dialog][data-state="open"]');
  return open.item(open.length - 1);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus goes when what opened a dialog (or popover) is gone, or the thing that had it left
 * the page (a row removed, a pane that went): never the page body. What had focus before (outside
 * any dialog or menu), else the trigger of the menu that was open, else the composer, else the
 * message list, else the conversation list's tab stop. While a focus policy is active (Vim's
 * navigation keys) the message list stands in for the composer, which only its own keys reach (M11).
 * Behind an open modal dialog nothing outside it is a place focus can go, so the choice stays
 * inside it (what had focus there, else its first control, else the dialog itself).
 */
export function fallbackFocus(): HTMLElement | null {
  const policy = conversationFocusPolicyActive();
  // The navigation drawer is modal: while it is open, what is behind it (the header button, the
  // composer) is not a place focus can go; it stays in the drawer's rail or list.
  const drawer = document.querySelector<HTMLElement>(NAV_DRAWER);
  const modal = openModal();
  const reachable = (el: HTMLElement | null): el is HTMLElement =>
    el !== null &&
    (drawer === null || drawer.contains(el)) &&
    (modal === null || modal.contains(el));
  for (const el of [...history].reverse()) {
    if (policy && el.matches(COMPOSER)) continue;
    // A dialog's own controls only count while that dialog is the one that stays open.
    const layer = el.closest('[role="dialog"]');
    if (
      el.isConnected &&
      reachable(el) &&
      (layer === null || layer === modal) &&
      !el.closest('[role="menu"], [data-sonner-toaster]')
    )
      return el;
  }
  const opener = rememberedMenuOpener();
  const found =
    (reachable(opener) ? opener : null) ??
    (() => {
      const place = composerOrMessageList();
      return reachable(place) ? place : null;
    })() ??
    (modal === null
      ? document.querySelector<HTMLElement>(
          '[data-snowdrop="sidebar"] [data-roving-item][tabindex="0"]',
        )
      : null);
  return found ?? (modal === null ? null : (modal.querySelector<HTMLElement>(FOCUSABLE) ?? modal));
}

export interface OpenerFocus {
  /** The element to give focus back to: the opener, or when it is gone the fallback chain (`fallbackFocus`). */
  opener(): HTMLElement | null;
  /**
   * For a layer's `onCloseAutoFocus`: takes over from Radix and puts focus
   * back on `fallback()` or else the opener (without popping its tooltip),
   * unless another dialog has taken over.
   */
  closeFocus(event: Event, fallback?: () => HTMLElement | null | undefined): void;
}

/**
 * The one place that remembers what opened a dialog, drawer or viewer and
 * puts focus back there on close. Standalone layers capture the focused
 * element each time they open; layers shown by `ModalHost` use its opener.
 */
export function useOpenerFocus(open = true): OpenerFocus {
  const host = useContext(HostContext);
  const own = useRef<HTMLElement | null>(null);
  /** Captured for this opening already (StrictMode runs the effect again after focus moved in). */
  const captured = useRef(false);
  // Before Radix moves focus into the layer (that happens in a later effect).
  useLayoutEffect(() => {
    if (!open) {
      captured.current = false;
      return undefined;
    }
    if (host) return host.register();
    if (!captured.current) {
      captured.current = true;
      own.current = focusedElement();
    }
    return undefined;
  }, [open, host]);
  // Stable, so an effect may list it.
  return useMemo(
    () => ({
      opener: () =>
        (host ? host.opener() : own.current?.isConnected ? own.current : null) ?? fallbackFocus(),
      closeFocus(event, fallback) {
        event.preventDefault();
        if (host && !host.settled()) return;
        const direct = fallback?.() ?? (host ? host.opener() : own.current);
        if (direct?.isConnected) {
          focusQuietly(direct);
          return;
        }
        // The opener went away: the fallback chain, unless the user already put focus somewhere.
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest('[role="dialog"]')) return;
        // Focus already inside a dialog that stays open (one that replaced this): not this one's to move.
        if (active && openModal()?.contains(active)) return;
        const target = fallbackFocus();
        if (target?.isConnected) focusQuietly(target);
      },
    }),
    [host],
  );
}
