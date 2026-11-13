import { Info, Pin, ShieldAlert, Timer, UserMinus, UserPlus, PenLine } from 'lucide-react';
import { memo } from 'react';
import { useStore } from 'zustand';
import { ignored } from '@/core/lib';
import { formatClock, type ConversationId, type MessageId, type SystemAction } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { useSnowdrop, useStores } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { canViewSafetyNumber, openSafetyNumber } from '@/ui/features/safety';
import styles from './Rows.module.css';

/** Picks an icon for a system line: by its button, else from its wording (the protocol gives only text). */
function SystemIcon({ text, action }: { text: string; action: SystemAction | undefined }) {
  const props = { size: 16, 'aria-hidden': true } as const;
  if (action?.kind === 'safety-number') return <ShieldAlert {...props} />;
  if (action?.kind === 'go-to-message') return <Pin {...props} />;
  const t = text.toLowerCase();
  if (t.includes('disappearing') || t.includes('timer')) return <Timer {...props} />;
  if (t.includes('joined') || t.includes('added')) return <UserPlus {...props} />;
  if (t.includes('left') || t.includes('removed')) return <UserMinus {...props} />;
  if (t.includes('changed') || t.includes('renamed') || t.includes('name'))
    return <PenLine {...props} />;
  return <Info {...props} />;
}

/** "Go to message" on a pin line: jumps to the pinned message. */
function GoToMessageButton({
  conversationId,
  target,
}: {
  conversationId: ConversationId;
  target: MessageId;
}) {
  const chat = useChatController();
  return (
    <button
      type="button"
      className={styles.systemAction}
      onClick={() => {
        chat.reveal(conversationId, target).catch(ignored('revealing a pinned message failed'));
      }}
    >
      Go to message
    </button>
  );
}

export const SystemRow = memo(function SystemRow({
  conversationId,
  id,
}: {
  conversationId: ConversationId;
  id: MessageId;
}) {
  const stores = useStores();
  const app = useSnowdrop();
  const m = useStore(stores.messages, messagesSelectors.message(conversationId, id));
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  if (!m) return null;
  const text = m.systemText ?? m.body;
  const action = m.systemAction;
  const safetyContact =
    action?.kind === 'safety-number' && canViewSafetyNumber(app, { isSelf: false })
      ? action.contactId
      : undefined;
  return (
    <div className={styles.system} data-snowdrop="system-message">
      <span className={styles.systemIcon}>
        <SystemIcon text={text} action={action} />
      </span>
      <span className={styles.systemText}>
        {text}
        {safetyContact !== undefined && (
          <button
            type="button"
            className={styles.systemAction}
            onClick={() => {
              openSafetyNumber(app, safetyContact);
            }}
          >
            View Safety Number
          </button>
        )}
        {action?.kind === 'go-to-message' && (
          <GoToMessageButton conversationId={conversationId} target={action.messageId} />
        )}
      </span>
      <time className={styles.systemTime} dateTime={new Date(m.sentAt).toISOString()}>
        {formatClock(m.sentAt, { clock24h })}
      </time>
    </div>
  );
});
