import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton';
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
  size?: 'sm' | 'md' | 'lg';
  /** Place the dialog near the top (quick switcher) instead of centred. */
  placement?: 'center' | 'top';
  /** Hide the visual header (title stays available to screen readers). */
  hideHeader?: boolean;
  className?: string | undefined;
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
}: ModalProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={[styles.content, className].filter(Boolean).join(' ')}
          data-size={size}
          data-placement={placement}
          {...(description ? {} : { 'aria-describedby': undefined })}
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
          {children !== undefined && <div className={styles.body}>{children}</div>}
          {footer && <footer className={styles.footer}>{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const ModalClose = RadixDialog.Close;
