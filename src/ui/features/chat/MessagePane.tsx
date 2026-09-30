import { ShieldCheck } from 'lucide-react';
import type { ConversationView } from '@/core/domain';
import { ConversationAvatar, usePeer } from '@/ui/features/conversation';
import { Scroller } from '@/ui/primitives';
import styles from './MessagePane.module.css';

/**
 * The message area frame. P3 mounts the virtualised list inside `.log`
 * (role="log"); until then it shows the conversation's opening block, which
 * the real list also renders above the oldest message.
 */
export function MessagePane({ conversation }: { conversation: ConversationView }) {
  const peer = usePeer(conversation);
  const isGroup = conversation.kind === 'group';
  return (
    <Scroller className={styles.pane} data-hearth="message-pane">
      <div
        className={styles.log}
        role="log"
        aria-live="polite"
        aria-label={`Messages in ${conversation.title}`}
      >
        <div className={styles.intro}>
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
        <p className={styles.pending}>Message history appears here in the next build.</p>
      </div>
    </Scroller>
  );
}
