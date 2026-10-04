import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, ConversationView } from '@/core/domain';
import { DEFAULT_LOCAL_CONVERSATION } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { ConversationAvatar, usePeer } from '@/ui/features/conversation';
import styles from './ListChrome.module.css';

/** The top of a conversation's history (shown once there's nothing older). */
export function ConversationIntro({ conversationId }: { conversationId: ConversationId }) {
  const stores = useStores();
  // Protocol state only: local state (the draft) changes on every keystroke.
  const protocol = useStore(stores.conversations, (s) => s.byId[conversationId]);
  const conversation = useMemo<ConversationView | undefined>(
    () => (protocol ? { ...protocol, ...DEFAULT_LOCAL_CONVERSATION } : undefined),
    [protocol],
  );
  const peer = usePeer(conversation);
  if (!conversation) return null;
  const isGroup = conversation.kind === 'group';
  return (
    <div className={styles.intro} data-snowdrop="conversation-intro">
      <ConversationAvatar conversation={conversation} size={80} />
      <h2 className={styles.title}>{conversation.title}</h2>
      <p className={styles.lede}>
        {isGroup ? (
          <>This is the start of your history in <bdi>{conversation.title}</bdi> on this device.</>
        ) : (
          <>
            This is the start of your history with <bdi>{peer?.name ?? conversation.title}</bdi> on
            this device.
          </>
        )}
      </p>
      {!isGroup && (
        <p className={styles.hint}>
          <ShieldCheck size={14} aria-hidden />
          Compare safety numbers in the Signal app on your phone to be sure it’s really them.
        </p>
      )}
    </div>
  );
}
