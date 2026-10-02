import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { focusQuietly } from './focusQuietly';
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
}: ModalProps) {
  // Captured on first render, i.e. before Radix moves focus into the dialog.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={[styles.content, className].filter(Boolean).join(' ')}
          data-size={size}
          data-placement={placement}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(e) => {
            // Radix would focus the first tabbable: the close button. Start
            // where the user will act instead.
            e.preventDefault();
            initialFocus(e.currentTarget as HTMLElement).focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const target = returnFocus?.() ?? (opener && document.contains(opener) ? opener : null);
            focusQuietly(target);
          }}
        >
          <header className={styles.header} data-hidden={hideHeader ? '' : undefined}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            {description && (
              <RadixDialog.Description className={styles.description}>
                {description}
              </RadixDialog.Description>
            )}
            <RadixDialog.Close asChild>
              <IconButton className={styles.close} label="Close" icon={<X />} noTooltip />
            </RadixDialog.Close>
          </header>
          {children !== undefined && (
            <div className={styles.body} data-flush={flush ? '' : undefined}>
              {children}
            </div>
          )}
          {footer && <footer className={styles.footer}>{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const ModalClose = RadixDialog.Close;
