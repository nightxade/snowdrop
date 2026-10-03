import { AtSign, Inbox } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { IconButton, Popover } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { MessageResult } from './MessageResult';
import { PopoverFrame, useOnOpen } from './ListPopover';
import styles from './ListPopover.module.css';

export function MentionsInbox() {
  const { repository, stores } = useSnowdrop();
  const chat = useChatController();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const titles = useStore(stores.conversations, (s) => s.byId);
  const [open, setOpen] = useState(false);
  const load = useOnOpen(
    open,
    () => (selfId ? repository.mentions(selfId, { limit: 30 }) : Promise.resolve([])),
    [selfId],
  );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      flush
      label="Mentions"
      trigger={<IconButton label="Mentions" icon={<Inbox />} active={open} tooltipSide="bottom" />}
    >
      <PopoverFrame
        title="Mentions"
        icon={<AtSign size={18} aria-hidden />}
        load={load}
        empty={
          <>
            <p className={styles.emptyTitle}>No mentions</p>
            <p>When someone @mentions you, it shows up here.</p>
          </>
        }
        render={(m) => {
          const conversation = titles[m.conversationId];
          return (
            <MessageResult
              message={m}
              {...(conversation
                ? {
                    context:
                      conversation.kind === 'group' ? `#${conversation.title}` : conversation.title,
                  }
                : {})}
              onOpen={() => {
                setOpen(false);
                stores.ui.getState().selectConversation(m.conversationId);
                void chat.reveal(m.conversationId, m.id);
              }}
            />
          );
        }}
      />
    </Popover>
  );
}
