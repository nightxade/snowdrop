import { Button, Modal } from '@/ui/primitives';
import styles from './ConfirmDelete.module.css';

/** Ending a poll can't be undone, so it asks first (the votes dialog and the message menu both come here). */
export function ConfirmEndPoll({
  question,
  onConfirm,
  onCancel,
}: {
  question: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      size="sm"
      title="End poll"
      description="Nobody will be able to vote after this, and everyone will see the results as final."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} data-autofocus>
            End poll
          </Button>
        </>
      }
    >
      <blockquote className={styles.preview}>
        <span className={styles.text}>{question}</span>
      </blockquote>
    </Modal>
  );
}
