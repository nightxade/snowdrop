import { Pin } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ConversationView } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { IconButton, Popover } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { chatSignature } from './chatSignature';
import { MessageResult } from './MessageResult';
import { PopoverFrame, useOnOpen } from './ListPopover';
import styles from './ListPopover.module.css';

export function PinnedPopover({ conversation }: { conversation: ConversationView }) {
  const { repository, stores } = useSnowdrop();
  const chat = useChatController();
  const [open, setOpen] = useState(false);
  // The list follows the chat while it is open (C14): a pin removed, a pinned message deleted or
  // expired leaves it, a new pin joins it.
  const pins = useStore(stores.messages, (s) => chatSignature(s, conversation.id, true));
  const load = useOnOpen(open, () => repository.pinned(conversation.id, 50), [
    conversation.id,
    pins,
  ]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      flush
      label="Pinned messages"
      trigger={
        <IconButton label="Pinned messages" icon={<Pin />} active={open} tooltipSide="bottom" />
      }
    >
      <PopoverFrame
        title="Pinned messages"
        icon={<Pin size={18} aria-hidden />}
        load={load}
        empty={
          <>
            <p className={styles.emptyTitle}>Nothing pinned yet</p>
            <p>Pin a message from its menu to keep it here for everyone in the conversation.</p>
          </>
        }
        render={(m) => (
          <MessageResult
            message={m}
            onOpen={() => {
              setOpen(false);
              void chat.reveal(conversation.id, m.id);
            }}
          />
        )}
      />
    </Popover>
  );
}
