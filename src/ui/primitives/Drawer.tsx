import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { focusQuietly } from './focusQuietly';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
  /** Edge it slides from. Default left (navigation); right for side sheets; bottom for action sheets. */
  side?: 'left' | 'right' | 'bottom';
  /**
   * Where focus goes on close when the drawer opened without a focused
   * opener (the navigation drawer is open at launch on phones) or the opener
   * has gone. Usually the button that toggles the drawer.
   */
  returnFocus?: () => HTMLElement | null | undefined;
}

const SWIPE_CLOSE_PX = 60;
/** Elements that handle Escape themselves (e.g. a shortcut recorder) mark themselves with this. */
const OWNS_ESCAPE = '[data-owns-escape]';

function focusedElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * Modal slide-over panel from a screen edge (small screens). Escape, the
 * scrim or a swipe back towards the edge close it; focus is trapped while
 * open.
 *
 * - One Escape closes it from anywhere inside, even when a tooltip of the
 *   focused button is showing (a tooltip is a layer of its own and would
 *   otherwise eat the first press). Layers opened *from* the drawer (menus,
 *   popovers, nested sheets) keep focus outside its DOM and close first.
 * - The element focused when it opened (the opener) gets focus back on
 *   close, whether the drawer closes or unmounts; `returnFocus` is the
 *   fallback.
 */
export function Drawer({
  open,
  onOpenChange,
  label,
  children,
  side = 'left',
  returnFocus,
}: DrawerProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  /** The panel element, kept after it unmounts so a close can tell focus was inside it. */
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef(onOpenChange);
  const fallback = useRef(returnFocus);
  useEffect(() => {
    close.current = onOpenChange;
    fallback.current = returnFocus;
  });

  // Record the opener on each closed → open transition (state adjusted during render).
  const [opener, setOpener] = useState(() => (open ? focusedElement() : null));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(focusedElement());
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const root = content.current;
      if (!root || !target || !root.contains(target) || target.closest(OWNS_ESCAPE)) return;
      e.preventDefault();
      close.current(false);
    };
    // Capture, registered when the drawer opens: runs before a tooltip layer
    // that opens later inside it, and after the dialog's own handler.
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      // Once the close has settled: step in unless something outside the
      // (possibly still animating out) panel took focus deliberately.
      requestAnimationFrame(() => {
        setTimeout(() => {
          const now = focusedElement();
          if (now?.isConnected && !panel.current?.contains(now)) return;
          const target = opener?.isConnected ? opener : fallback.current?.();
          focusQuietly(target);
        }, 0);
      });
    };
  }, [open, opener]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          ref={(el) => {
            content.current = el;
            if (el) panel.current = el;
          }}
          className={styles.content}
          data-side={side}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the panel itself rather than its first button, so opening
            // the drawer doesn't pop that button's tooltip; Tab/arrows go on from here.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Restored by the effect above (it also covers unmounting while open).
            e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (focusedElement()?.closest(OWNS_ESCAPE)) e.preventDefault();
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== 'mouse') start.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            const s = start.current;
            start.current = null;
            if (!s) return;
            const dx = e.clientX - s.x;
            const dy = e.clientY - s.y;
            if (side === 'bottom') {
              if (dy > SWIPE_CLOSE_PX && Math.abs(dx) < dy) onOpenChange(false);
              return;
            }
            const towardEdge = side === 'left' ? dx < -SWIPE_CLOSE_PX : dx > SWIPE_CLOSE_PX;
            if (towardEdge && Math.abs(e.clientY - s.y) < Math.abs(dx)) onOpenChange(false);
          }}
        >
          <RadixDialog.Title className={styles.title}>{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
