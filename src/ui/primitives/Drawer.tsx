import * as RadixDialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
  /** Edge it slides from. Default left (navigation); right for side sheets; bottom for action sheets. */
  side?: 'left' | 'right' | 'bottom';
}

const SWIPE_CLOSE_PX = 60;

/**
 * Modal slide-over panel from a screen edge (small screens). Escape, the
 * scrim or a swipe back towards the edge close it; focus is trapped while
 * open and returns to where it was on close.
 */
export function Drawer({ open, onOpenChange, label, children, side = 'left' }: DrawerProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          data-side={side}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Focus the panel itself rather than its first button, so opening
            // the drawer doesn't pop that button's tooltip; Tab/arrows go on from here.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
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
