import { useStore } from 'zustand';
import { bodyToPlainText, type Message } from '@/core/domain';
import { contactsSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { Button, Kbd, Modal } from '@/ui/primitives';
import type { DeleteKind } from './messageMenu';
import styles from './ConfirmDelete.module.css';

const COPY: Record<DeleteKind, { title: string; body: string; action: string }> = {
  everyone: {
    title: 'Delete for everyone',
    body: 'This removes the message for everyone in the conversation. People may already have seen it.',
    action: 'Delete for everyone',
  },
  admin: {
    title: 'Delete for everyone',
    body: 'As an admin you can remove this message for all members. They will see that an admin deleted it.',
    action: 'Delete for everyone',
  },
  me: {
    title: 'Delete for me',
    body: 'This removes the message from this device only. Everyone else still has it.',
    action: 'Delete for me',
  },
};

export function ConfirmDelete({
  kind,
  message,
  onConfirm,
  onCancel,
}: {
  kind: DeleteKind;
  message: Message;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const stores = useStores();
  const name =
    useStore(stores.contacts, contactsSelectors.displayName(message.authorId)) ||
    UNKNOWN_CONTACT_NAME;
  const byId = useStore(stores.contacts, contactsSelectors.byId);
  const text = bodyToPlainText(
    message.body,
    message.ranges,
    (id) => byId[id]?.name ?? UNKNOWN_CONTACT_NAME,
  );
  const copy = COPY[kind];
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      size="sm"
      title={copy.title}
      description={copy.body}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} data-autofocus>
            {copy.action}
          </Button>
        </>
      }
    >
      <blockquote className={styles.preview}>
        <span className={styles.author}>{name}</span>
        <span className={styles.text}>{text || 'Attachment'}</span>
      </blockquote>
      <p className={styles.tip}>
        Tip: hold <Kbd combo="Shift" /> while deleting to skip this.
      </p>
    </Modal>
  );
}
