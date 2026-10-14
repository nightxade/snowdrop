import * as RadixDialog from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import { focusQuietly } from './focusQuietly';
import styles from './FullScreenDialog.module.css';

export interface FullScreenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name (visually hidden; the content shows its own headings). */
  title: string;
  children: ReactNode;
  /** CSS selector of the element to focus on open (else the dialog itself). */
  initialFocus?: string | undefined;
  className?: string | undefined;
}

/** Elements that handle Escape themselves (e.g. a shortcut recorder) mark themselves with this. */
const OWNS_ESCAPE = '[data-owns-escape]';

/**
 * A dialog that covers the whole window (settings). Focus is trapped while
 * open, Escape closes, and focus returns to the opener on close.
 */
export function FullScreenDialog({
  open,
  onOpenChange,
  title,
  children,
  initialFocus,
  className,
}: FullScreenDialogProps) {
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          className={[styles.content, className].filter(Boolean).join(' ')}
          // TUI shell only (src/ui/styles/tui.css): the titled border reads this;
          // inert markup otherwise.
          data-pane-title={title.toLowerCase()}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const root = e.currentTarget as HTMLElement;
            const target = initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null;
            (target ?? root).focus();
          }}
          onEscapeKeyDown={(e) => {
            if (document.activeElement?.closest(OWNS_ESCAPE)) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener && document.contains(opener)) focusQuietly(opener);
          }}
        >
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
