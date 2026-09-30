import { Slot as RadixSlot } from '@radix-ui/react-slot';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import styles from './Tooltip.module.css';

export interface TooltipProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  label: ReactNode;
  /** Optional shortcut shown after the label, e.g. "Ctrl+K". */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger; must forward refs and props (a DOM element or forwarding component). */
  children: ReactElement;
  /** Suppress the tooltip (e.g. while a menu is open). */
  disabled?: boolean;
  delayMs?: number;
  ref?: Ref<HTMLButtonElement> | undefined;
}

/** Mount once near the root: shares the open delay so moving between triggers is instant. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={250}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * Extra props (handlers, refs, aria) from an outer `asChild` wrapper are
 * passed through to the trigger, so Tooltip composes with menus/popovers.
 */
export function Tooltip({
  label,
  shortcut,
  side = 'top',
  children,
  disabled,
  delayMs,
  ...trigger
}: TooltipProps) {
  if (disabled) return <RadixSlot {...trigger}>{children}</RadixSlot>;
  return (
    <RadixTooltip.Root {...(delayMs !== undefined ? { delayDuration: delayMs } : {})}>
      <RadixTooltip.Trigger asChild {...trigger}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={styles.content}
          side={side}
          sideOffset={side === 'right' ? 12 : 6}
          collisionPadding={8}
        >
          <span>{label}</span>
          {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
