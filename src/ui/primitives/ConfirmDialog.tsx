import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  /** Destructive actions focus Cancel, so Enter can't do harm by accident. */
  danger?: boolean;
  disabled?: boolean;
  /** Resolves to null when done, else the sentence to show. */
  run: () => Promise<string | null>;
  onClose: () => void;
  children?: ReactNode;
}

/**
 * Asks, then runs an action that takes a moment and can be refused: the
 * button shows it is working, the dialog can't be dismissed meanwhile, a
 * refusal is read out and stays on screen, and the dialog closes only once
 * the action went through.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  danger,
  disabled,
  run,
  onClose,
  children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await run();
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            {...(danger ? { 'data-autofocus': '' } : {})}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || disabled}
            aria-busy={busy}
            {...(danger ? {} : { 'data-autofocus': '' })}
            onClick={() => void confirm()}
          >
            {busy ? (busyLabel ?? 'Working…') : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <p className={styles.error} role="alert">
        {error}
      </p>
    </Modal>
  );
}
