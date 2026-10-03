import { Pin, Timer } from 'lucide-react';
import { useStore } from 'zustand';
import {
  formatClock,
  formatFullTimestamp,
  formatMessageTimestamp,
  MINUTE,
  HOUR,
  DAY,
  type Message,
} from '@/core/domain';
import { useShrike } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import { useMinuteClock } from '../lib/useMinuteClock';
import styles from './MessageMeta.module.css';

function countdown(ms: number): string {
  if (ms <= MINUTE) return 'less than a minute';
  if (ms < HOUR) return `${Math.ceil(ms / MINUTE)} minutes`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / DAY)} days`;
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
  const { stores } = useShrike();
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
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
        dateTime={new Date(m.sentAt).toISOString()}
      >
        {label}
      </time>
    </Tooltip>
  );
  if (variant !== 'header') return time;
  return (
    <>
      {time}
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
