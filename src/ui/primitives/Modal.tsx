import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton';
import { OpenerReset, useOpenerFocus } from './openerFocus';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One line under the title; also the dialog's accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action row. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Place the dialog near the top (quick switcher) instead of centred. */
  placement?: 'center' | 'top';
  /** Hide the visual header (title stays available to screen readers). */
  hideHeader?: boolean;
  className?: string | undefined;
  /** No padding around the body (palettes, full-bleed content). */
  flush?: boolean;
  /**
   * Where focus goes on close. Defaults to the element focused when the modal
   * opened (if it's still in the document). Return null to use that default.
   */
  returnFocus?: () => HTMLElement | null | undefined;
  /**
   * False for a dialog that must be finished on purpose (something shown
   * once, say): Escape and outside clicks do nothing but call
   * `onDismissAttempt`, and the header's close button is left out. The dialog
   * still needs its own clear way forward, and should say why it stays open.
   */
  dismissible?: boolean;
  /** An Escape or outside click was ignored because `dismissible` is false. */
  onDismissAttempt?: () => void;
}

/** First element marked `data-autofocus`, else the first field, else the dialog itself. */
function initialFocus(content: HTMLElement): HTMLElement {
  return (
    content.querySelector<HTMLElement>('[data-autofocus]') ??
    content.querySelector<HTMLElement>(
      'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    ) ??
    content
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  placement = 'center',
  hideHeader,
  className,
  flush,
  returnFocus,
  dismissible = true,
  onDismissAttempt,
}: ModalProps) {
  const focus = useOpenerFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={[styles.content, className].filter(Boolean).join(' ')}
          data-size={size}
          data-placement={placement}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onEscapeKeyDown={(e) => {
            if (dismissible) return;
            e.preventDefault();
            onDismissAttempt?.();
          }}
          onInteractOutside={(e) => {
            // Also covers focus moving out (a dialog swap, say): ignore it.
            if (!dismissible) e.preventDefault();
          }}
          onPointerDownOutside={() => {
            if (!dismissible) onDismissAttempt?.();
          }}
          onOpenAutoFocus={(e) => {
            // Radix would focus the first tabbable: the close button. Start
            // where the user will act instead.
            e.preventDefault();
            initialFocus(e.currentTarget as HTMLElement).focus();
          }}
          onCloseAutoFocus={(e) => {
            focus.closeFocus(e, returnFocus);
          }}
        >
          <header className={styles.header} data-hidden={hideHeader ? '' : undefined}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            {description && (
              <RadixDialog.Description className={styles.description}>
                {description}
              </RadixDialog.Description>
            )}
            {/* A hidden header must not leave an invisible Close in the Tab order:
                Escape and a click outside close the dialog. */}
            {dismissible && !hideHeader && (
              <RadixDialog.Close asChild>
                <IconButton className={styles.close} label="Close" icon={<X />} noTooltip />
              </RadixDialog.Close>
            )}
          </header>
          <OpenerReset>
            {children !== undefined && (
              <div className={styles.body} data-flush={flush ? '' : undefined}>
                {children}
              </div>
            )}
            {footer && <footer className={styles.footer}>{footer}</footer>}
          </OpenerReset>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const ModalClose = RadixDialog.Close;
