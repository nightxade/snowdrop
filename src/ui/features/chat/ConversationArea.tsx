import { memo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { useStores } from '@/ui/hooks';
import { useChatController } from './ChatController';
import { Composer } from './composer/Composer';
import { DropOverlay, useFileDrop } from './DropOverlay';
import { MessagePane } from './MessagePane';
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
  const drop = useFileDrop((files) => {
    chat.addFiles(files);
    chat.focusComposer();
  });
  return (
    <div className={styles.area} data-tui-flatten {...drop.handlers}>
      <MessagePane conversationId={conversationId} />
      <Composer conversationId={conversationId} />
      {drop.dragging && <DropOverlay target={title} />}
    </div>
  );
});
