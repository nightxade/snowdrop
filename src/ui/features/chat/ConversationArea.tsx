import { memo } from 'react';
import { useStore } from 'zustand';
import { canSendToGroup, type ConversationId } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useMessageRequestState } from '@/ui/features/conversation';
import { useStores } from '@/ui/hooks';
import { useChatController } from './ChatController';
import { Composer } from './composer/Composer';
import { DropOverlay, useFileDrop } from './DropOverlay';
import { MessagePane } from './MessagePane';
import { GroupNoticeBar } from './request/GroupNoticeBar';
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
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  // An announcement group: only admins can write. Unknown rules mean anyone can.
  const canSend = useStore(stores.conversations, (s) =>
    canSendToGroup(s.byId[conversationId], selfId),
  );
  const left = useStore(stores.conversations, (s) => s.byId[conversationId]?.left === true);
  const writable = requestState === 'accepted' && canSend;
  const drop = useFileDrop((files) => {
    chat.addFiles(files);
    chat.focusComposer();
  });
  return (
    <div
      className={styles.area}
      data-tui-flatten
      // Nothing can be attached where nothing can be written.
      {...(writable ? drop.handlers : {})}
    >
      <MessagePane conversationId={conversationId} />
      {requestState !== 'accepted' ? (
        <MessageRequestBar conversationId={conversationId} state={requestState} />
      ) : canSend ? (
        <Composer conversationId={conversationId} />
      ) : (
        <GroupNoticeBar reason={left ? 'left' : 'announcement'} />
      )}
      {drop.dragging && writable && <DropOverlay target={title} />}
    </div>
  );
});
