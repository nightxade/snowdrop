import { Check, CheckCheck, Clock, Pin, Timer } from 'lucide-react';
import { useStore } from 'zustand';
import {
  formatClock,
  formatFullTimestamp,
  formatMessageTimestamp,
  MINUTE,
  HOUR,
  DAY,
  type Message,
  type MessageStatus,
} from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import { useMinuteClock } from '../lib/useMinuteClock';
import styles from './MessageMeta.module.css';

function countdown(ms: number): string {
  if (ms <= MINUTE) return 'less than a minute';
  if (ms < HOUR) return `${Math.ceil(ms / MINUTE)} minutes`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / DAY)} days`;
}

const STATUS_LABEL: Record<Exclude<MessageStatus, 'failed'>, string> = {
  pending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

/**
 * Delivery/read mark for an outgoing message, in the same spot Signal puts
 * it: right after the timestamp. One hollow clock (pending), one check
 * (sent), two checks (delivered), two checks in the accent colour (read).
 * Failed sends never reach here — `MessageNotes` owns that state, and it
 * stays visible regardless of Settings → Privacy → "Show read receipts".
 */
function MessageStatusMark({
  status,
  quiet,
}: {
  status: Exclude<MessageStatus, 'failed'>;
  quiet: boolean;
}) {
  const label = STATUS_LABEL[status];
  return (
    <Tooltip label={label} disabled={quiet}>
      <span
        className={styles.status}
        data-snowdrop="message-status"
        data-status={status}
        tabIndex={0}
        aria-label={label}
      >
        {status === 'pending' && <Clock size={12} aria-hidden />}
        {status === 'sent' && <Check size={12} aria-hidden />}
        {(status === 'delivered' || status === 'read') && <CheckCheck size={12} aria-hidden />}
      </span>
    </Tooltip>
  );
}
/**
 * Timestamp (with full-date tooltip) plus small state marks. `header` sits
 * after the author name; `gutter` is the hover time of a continuation row;
 * `compact` is the fixed-width time column of compact mode.
 */
export function MessageMeta({
  message: m,
  variant,
  quiet = false,
}: {
  message: Message;
  variant: 'header' | 'gutter' | 'compact';
  /** Suppress the full-date tooltip (the row's context menu is open). */
  quiet?: boolean;
}) {
  const { stores } = useSnowdrop();
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const showStatus = useEffectivePrivacy().showReadReceipts;
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const now = useMinuteClock();
  const opts = { clock24h };
  const full = formatFullTimestamp(m.sentAt, opts);
  const label =
    variant === 'header'
      ? formatMessageTimestamp(m.sentAt, now, opts)
      : formatClock(m.sentAt, opts);

  const time = (
    <Tooltip label={full} delayMs={500} disabled={quiet}>
      <time
        className={styles.time}
        data-variant={variant}
        data-snowdrop="message-time"
        dateTime={new Date(m.sentAt).toISOString()}
      >
        {label}
      </time>
    </Tooltip>
  );
  // Own, normal messages only: incoming messages carry no delivery status of
  // their own (see Message.status), and a failed send shows in MessageNotes
  // instead, not here.
  const status =
    showStatus && m.authorId === selfId && m.kind === 'normal' && m.status !== 'failed'
      ? m.status
      : null;
  const mark = status && <MessageStatusMark status={status} quiet={quiet} />;
  if (variant !== 'header')
    return (
      <>
        {time}
        {mark}
      </>
    );
  return (
    <>
      {time}
      {mark}
      {m.expiresAt !== undefined && (
        <Tooltip label={`Disappears in ${countdown(m.expiresAt - now)}`}>
          <span className={styles.mark} tabIndex={0} aria-label="Disappearing message">
            <Timer size={12} aria-hidden />
          </span>
        </Tooltip>
      )}
      {m.pinned && (
        <Tooltip label="Pinned">
          <span className={styles.mark} data-pinned="" tabIndex={0} aria-label="Pinned">
            <Pin size={12} aria-hidden />
          </span>
        </Tooltip>
      )}
    </>
  );
}
