import { Copy, Timer } from 'lucide-react';
import { formatDuration, type ConversationView } from '@/core/domain';
import { useShrike } from '@/ui/hooks';
import { ConversationAvatar, copyText, usePeer } from '@/ui/features/conversation';
import { Button } from '@/ui/primitives';
import styles from './ConversationDetails.module.css';

/** The "about this conversation" popover opened from the header title. */
export function ConversationDetails({ conversation }: { conversation: ConversationView }) {
  const app = useShrike();
  const peer = usePeer(conversation);
  const isGroup = conversation.kind === 'group';
  const about = isGroup ? conversation.description : peer?.about;
  return (
    <div className={styles.details}>
      <div className={styles.top}>
        <ConversationAvatar conversation={conversation} size={48} />
        <div className={styles.names}>
          <p className={styles.title}>{conversation.title}</p>
          <p className={styles.meta}>
            {isGroup
              ? `Group, ${conversation.memberIds.length} members`
              : (peer?.number ?? 'Direct message')}
          </p>
        </div>
      </div>
      {about && <p className={styles.about}>{about}</p>}
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>
            <Timer size={14} aria-hidden /> Disappearing messages
          </dt>
          <dd>{formatDuration(conversation.expireTimerSec)}</dd>
        </div>
      </dl>
      <Button
        size="sm"
        variant="secondary"
        icon={<Copy size={14} />}
        onClick={() => {
          void copyText(app, conversation.id, 'conversation ID');
        }}
      >
        Copy ID
      </Button>
    </div>
  );
}
