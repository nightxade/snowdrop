import { Info, ShieldAlert, Timer, UserMinus, UserPlus, PenLine } from 'lucide-react';
import { memo } from 'react';
import { useStore } from 'zustand';
import { formatClock, type ConversationId, type MessageId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { useSnowdrop, useStores } from '@/ui/hooks';
import { canViewSafetyNumber, openSafetyNumber } from '@/ui/features/safety';
import styles from './Rows.module.css';

/** Picks an icon for a system line from its wording (the protocol gives only text). */
function systemIcon(text: string) {
  const t = text.toLowerCase();
  if (t.includes('disappearing') || t.includes('timer')) return Timer;
  if (t.includes('joined') || t.includes('added')) return UserPlus;
  if (t.includes('left') || t.includes('removed')) return UserMinus;
  if (t.includes('changed') || t.includes('renamed') || t.includes('name')) return PenLine;
  return Info;
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
  const Icon = action ? ShieldAlert : systemIcon(text);
  const safetyContact =
    action?.kind === 'safety-number' && canViewSafetyNumber(app, { isSelf: false })
      ? action.contactId
      : undefined;
  return (
    <div className={styles.system} data-snowdrop="system-message">
      <span className={styles.systemIcon}>
        <Icon size={16} aria-hidden />
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
      </span>
      <time className={styles.systemTime} dateTime={new Date(m.sentAt).toISOString()}>
        {formatClock(m.sentAt, { clock24h })}
      </time>
    </div>
  );
});
