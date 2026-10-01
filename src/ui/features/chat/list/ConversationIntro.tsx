import { ShieldCheck } from 'lucide-react';
import type { ConversationView } from '@/core/domain';
import { ConversationAvatar, usePeer } from '@/ui/features/conversation';
import styles from './ListChrome.module.css';

/** The top of a conversation's history (shown once there's nothing older). */
export function ConversationIntro({ conversation }: { conversation: ConversationView }) {
  const peer = usePeer(conversation);
  const isGroup = conversation.kind === 'group';
  return (
    <div className={styles.intro} data-shrike="conversation-intro">
      <ConversationAvatar conversation={conversation} size={80} />
      <h2 className={styles.title}>{conversation.title}</h2>
      <p className={styles.lede}>
        {isGroup
          ? `This is the start of the ${conversation.title} group.`
          : `This is the beginning of your conversation with ${peer?.name ?? conversation.title}.`}
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
