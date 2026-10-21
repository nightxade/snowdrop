import { memo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { useMessageRequestState } from '@/ui/features/conversation';
import { useStores } from '@/ui/hooks';
import { useChatController } from './ChatController';
import { Composer } from './composer/Composer';
import { DropOverlay, useFileDrop } from './DropOverlay';
import { MessagePane } from './MessagePane';
import { MessageRequestBar } from './request/MessageRequestBar';
import styles from './ConversationArea.module.css';

/** Messages + composer of the open conversation, with the file drop target over both. */
export const ConversationArea = memo(function ConversationArea({
  conversationId,
}: {
  conversationId: ConversationId;
}) {
  const stores = useStores();
  const chat = useChatController();
  const title = useStore(stores.conversations, (s) => {
    const c = s.byId[conversationId];
    if (!c) return '';
    return c.kind === 'group' ? `#${c.title}` : `@${c.title}`;
  });
  const requestState = useMessageRequestState(conversationId);
  const drop = useFileDrop((files) => {
    chat.addFiles(files);
    chat.focusComposer();
  });
  return (
    <div
      className={styles.area}
      data-tui-flatten
      // Nothing can be attached where nothing can be written.
      {...(requestState === 'accepted' ? drop.handlers : {})}
    >
      <MessagePane conversationId={conversationId} />
      {requestState === 'accepted' ? (
        <Composer conversationId={conversationId} />
      ) : (
        <MessageRequestBar conversationId={conversationId} state={requestState} />
      )}
      {drop.dragging && requestState === 'accepted' && <DropOverlay target={title} />}
    </div>
  );
});
