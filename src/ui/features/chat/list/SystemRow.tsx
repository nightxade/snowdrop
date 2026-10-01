import { Info, Timer, UserMinus, UserPlus, PenLine } from 'lucide-react';
import { memo } from 'react';
import { useStore } from 'zustand';
import { formatClock, type ConversationId, type MessageId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
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
  const m = useStore(stores.messages, messagesSelectors.message(conversationId, id));
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  if (!m) return null;
  const text = m.systemText ?? m.body;
  const Icon = systemIcon(text);
  return (
    <div className={styles.system} data-hearth="system-message">
      <span className={styles.systemIcon}>
        <Icon size={16} aria-hidden />
      </span>
      <span className={styles.systemText}>{text}</span>
      <time className={styles.systemTime} dateTime={new Date(m.sentAt).toISOString()}>
        {formatClock(m.sentAt, { clock24h })}
      </time>
    </div>
  );
});
