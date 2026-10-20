import { useState, type ReactElement } from 'react';
import type { ConversationId, CustomEmojiDelivery } from '@/core/domain';
import { Modal, Popover } from '@/ui/primitives';
import { CustomEmojiCard } from './CustomEmojiCard';
import styles from './CustomEmojiPopover.module.css';

export interface CustomEmojiPopoverProps {
  conversationId: ConversationId;
  delivery: CustomEmojiDelivery;
  /** The inline emoji image; it becomes the popover's trigger. */
  children: ReactElement;
}

/** An emoji someone else delivered, inline in their message: click it to see it and add it to your own. */
export function CustomEmojiPopover({
  conversationId,
  delivery,
  children,
}: CustomEmojiPopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`Custom emoji :${delivery.name}:`}
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-label={`Custom emoji :${delivery.name}:, add to my emoji`}
          aria-haspopup="dialog"
        >
          {children}
        </button>
      }
    >
      {open && <CustomEmojiCard conversationId={conversationId} delivery={delivery} />}
    </Popover>
  );
}

/** The same card as a dialog, for the message's context menu (no inline image to anchor to). */
export function CustomEmojiDialog({
  conversationId,
  delivery,
  onOpenChange,
}: Omit<CustomEmojiPopoverProps, 'children'> & { onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open onOpenChange={onOpenChange} title="Add to my emoji" size="sm">
      <CustomEmojiCard conversationId={conversationId} delivery={delivery} />
    </Modal>
  );
}
