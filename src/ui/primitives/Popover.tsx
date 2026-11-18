import * as RadixPopover from '@radix-ui/react-popover';
import { useRef, type ReactElement, type ReactNode } from 'react';
import { focusQuietly } from './focusQuietly';
import { fallbackFocus } from './openerFocus';
import styles from './Popover.module.css';

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name for the dialog surface. */
  label: string;
  className?: string | undefined;
  /** Remove the default padding (for popouts with edge-to-edge banners). */
  flush?: boolean;
  /** Where focus goes on open, instead of the first focusable element. */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Where focus goes on close, instead of the trigger: call `preventDefault`
   * and focus it yourself. Leave the event alone to get the trigger back.
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 8,
  open,
  onOpenChange,
  label,
  className,
  flush,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: PopoverProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <RadixPopover.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixPopover.Trigger asChild ref={anchor}>
        {trigger}
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={[styles.content, className].filter(Boolean).join(' ')}
          data-flush={flush ? '' : undefined}
          side={side}
          align={align}
          sideOffset={sideOffset}
          avoidCollisions
          collisionPadding={12}
          aria-label={label}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
          onCloseAutoFocus={(e) => {
            onCloseAutoFocus?.(e);
            if (e.defaultPrevented && onCloseAutoFocus) return;
            // Back on the trigger without popping its tooltip; when the trigger went with what it
            // belonged to (a member removed under their card), the fallback, unless focus is
            // somewhere already.
            e.preventDefault();
            if (anchor.current?.isConnected) focusQuietly(anchor.current);
            else if (!document.activeElement || document.activeElement === document.body)
              focusQuietly(fallbackFocus());
          }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export const PopoverClose = RadixPopover.Close;
