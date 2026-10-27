import { Modal } from '@/ui/primitives';
import { SafetyNumberView } from './SafetyNumberView';

/** Signal Desktop's "Verify Safety Number" dialog for one person. */
export function SafetyNumberDialog({
  contactId,
  onClose,
}: {
  contactId: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Verify Safety Number"
    >
      <SafetyNumberView contactId={contactId} onClose={onClose} />
    </Modal>
  );
}
