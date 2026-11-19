import { memo } from 'react';
import { useStore } from 'zustand';
import { canSendToGroup, type ConversationId } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useMessageRequestState } from '@/ui/features/conversation';
import { useHandOffWhenGone, useStores } from '@/ui/hooks';
import { composerOrMessageList, messageListStop } from '@/ui/primitives';
import { useChatController } from './ChatController';
import { Composer } from './composer/Composer';
import { DropOverlay, useFileDrop } from './DropOverlay';
import { MessagePane } from './MessagePane';
import { GroupNoticeBar } from './request/GroupNoticeBar';
import { MessageRequestBar } from './request/MessageRequestBar';
import styles from './ConversationArea.module.css';

const COMPOSER = '[data-snowdrop="composer"]';
const BAR = '[data-snowdrop="message-request"]';

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
  // What had focus at the bottom of the chat is replaced: the composer by a notice or the request
  // bar (made admins-only, left, blocked), a request bar's button by the composer (answered on the
  // phone) or by another bar. Focus goes to the composer if one shows, else the message list, never
  // the page (M15).
  useHandOffWhenGone({
    scope: conversationId,
    identify: (el) => {
      if (el.closest(COMPOSER)) return 'composer';
      const button = el.closest(`${BAR} button`);
      return button ? `button:${button.textContent.trim()}` : null;
    },
    stillThere: (id) =>
      id === 'composer'
        ? document.querySelector(COMPOSER) !== null
        : [...document.querySelectorAll(`${BAR} button`)].some(
            (b) => `button:${b.textContent.trim()}` === id,
          ),
    replacement: (gone) => (gone === 'composer' ? messageListStop() : composerOrMessageList()),
  });
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
