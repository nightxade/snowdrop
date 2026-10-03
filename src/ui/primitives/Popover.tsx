import * as RadixPopover from '@radix-ui/react-popover';
import { useRef, type ReactElement, type ReactNode } from 'react';
import { focusQuietly } from './focusQuietly';
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
          onCloseAutoFocus={(e) => {
            // Back on the trigger without popping its tooltip.
            e.preventDefault();
            if (anchor.current?.isConnected) focusQuietly(anchor.current);
          }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export const PopoverClose = RadixPopover.Close;
