import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { focusQuietly } from './focusQuietly';

/**
 * What the dialog host (`ModalHost`) gives the dialogs it shows. It owns the
 * opener of the whole chain: the element that was focused when the first
 * dialog was requested. Dialogs that replace each other (New message to New
 * group, Reset link and back) never become openers themselves, and only the
 * end of the chain returns focus.
 */
export interface OpenerHost {
  /** The element that opened the first dialog of the chain, if there was one. */
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
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

export interface OpenerFocus {
  /** The element to give focus back to, if any. */
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
      opener: () => (host ? host.opener() : own.current),
      closeFocus(event, fallback) {
        event.preventDefault();
        if (host && !host.settled()) return;
        const target = fallback?.() ?? (host ? host.opener() : own.current);
        if (target?.isConnected) focusQuietly(target);
      },
    }),
    [host],
  );
}
