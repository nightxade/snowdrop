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
        role="img"
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
 * One time label. Only the header's depends on "now" and subscribes to the
 * shared minute clock (`HeaderTime`), so a minute ticking over re-renders one
 * label per visible message, not every mark of every row.
 */
function Timestamp({
  sentAt,
  label,
  variant,
  quiet,
  clock24h,
}: {
  sentAt: number;
  label: string;
  variant: 'header' | 'gutter' | 'compact';
  quiet: boolean;
  clock24h: boolean;
}) {
  const full = formatFullTimestamp(sentAt, { clock24h });
  return (
    <Tooltip label={full} delayMs={500} disabled={quiet}>
      <time
        className={styles.time}
        data-variant={variant}
        data-snowdrop="message-time"
        dateTime={new Date(sentAt).toISOString()}
      >
        {label}
      </time>
    </Tooltip>
  );
}

function HeaderTime({
  sentAt,
  quiet,
  clock24h,
}: {
  sentAt: number;
  quiet: boolean;
  clock24h: boolean;
}) {
  const now = useMinuteClock();
  return (
    <Timestamp
      sentAt={sentAt}
      label={formatMessageTimestamp(sentAt, now, { clock24h })}
      variant="header"
      quiet={quiet}
      clock24h={clock24h}
    />
  );
}

/** The delivery mark of an own message, which alone needs the read-receipts setting. */
function OwnStatusMark({ status, quiet }: { status: MessageStatus; quiet: boolean }) {
  const showStatus = useEffectivePrivacy().showReadReceipts;
  if (!showStatus || status === 'failed') return null;
  return <MessageStatusMark status={status} quiet={quiet} />;
}

function DisappearsTooltip({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <span className={styles.mark} tabIndex={0} role="img" aria-label="Disappearing message">
        <Timer size={12} aria-hidden />
      </span>
    </Tooltip>
  );
}

/** A countdown to a fixed time: the only mark that follows the clock. */
function DisappearsMark({ expiresAt }: { expiresAt: number }) {
  const now = useMinuteClock();
  return <DisappearsTooltip label={`Disappears in ${countdown(expiresAt - now)}`} />;
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
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const time =
    variant === 'header' ? (
      <HeaderTime sentAt={m.sentAt} quiet={quiet} clock24h={clock24h} />
    ) : (
      <Timestamp
        sentAt={m.sentAt}
        label={formatClock(m.sentAt, { clock24h })}
        variant={variant}
        quiet={quiet}
        clock24h={clock24h}
      />
    );
  // Own, normal messages only: incoming messages carry no delivery status of
  // their own (see Message.status), and a failed send shows in MessageNotes
  // instead, not here.
  const own = m.authorId === selfId && m.kind === 'normal' && m.status !== 'failed';
  const mark = own && <OwnStatusMark status={m.status} quiet={quiet} />;
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
      {m.expiresAt !== undefined ? (
        <DisappearsMark expiresAt={m.expiresAt} />
      ) : (
        m.expiresAfterReadMs !== undefined && (
          <DisappearsTooltip
            label={`Disappears ${countdown(m.expiresAfterReadMs)} after you read it`}
          />
        )
      )}
      {m.pinned && (
        <Tooltip label="Pinned">
          <span className={styles.mark} data-pinned="" tabIndex={0} role="img" aria-label="Pinned">
            <Pin size={12} aria-hidden />
          </span>
        </Tooltip>
      )}
    </>
  );
}
