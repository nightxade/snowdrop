import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
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

/**
 * Where focus goes when what opened a dialog (or popover) is gone, never the page body: what had
 * focus before (outside any dialog or menu), else the trigger of the menu that was open, else the
 * composer, else the message list.
 */
export function fallbackFocus(): HTMLElement | null {
  for (const el of [...history].reverse()) {
    if (el.isConnected && !el.closest('[role="dialog"], [role="menu"]')) return el;
  }
  return (
    rememberedMenuOpener() ??
    document.querySelector<HTMLElement>('[data-snowdrop="composer-input"]') ??
    document.querySelector<HTMLElement>('[data-snowdrop="message-log"]')
  );
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
        const target = fallbackFocus();
        if (target?.isConnected) focusQuietly(target);
      },
    }),
    [host],
  );
}
