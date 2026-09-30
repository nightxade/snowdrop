import * as RadixDialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
}

const SWIPE_CLOSE_PX = 60;

/**
 * Slide-over panel from the left edge (small screens). Escape, the scrim or a
 * leftward swipe close it; focus is trapped while open.
 */
export function Drawer({ open, onOpenChange, label, children }: DrawerProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
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
            if (dx < -SWIPE_CLOSE_PX && Math.abs(e.clientY - s.y) < Math.abs(dx))
              onOpenChange(false);
          }}
        >
          <RadixDialog.Title className={styles.title}>{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
