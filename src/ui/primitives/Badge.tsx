import styles from './Badge.module.css';

export interface BadgeProps {
  /** 'mention' = red count pill, 'count' = neutral count pill, 'dot' = small unread dot. */
  variant?: 'mention' | 'count' | 'dot';
  count?: number;
  /** Counts above this render as "max+". */
  max?: number;
  /** Accessible description, e.g. "3 mentions". */
  label?: string;
  className?: string | undefined;
}

export function formatBadgeCount(count: number, max = 99): string {
  return count > max ? `${max}+` : String(count);
}

export function Badge({ variant = 'mention', count = 0, max = 99, label, className }: BadgeProps) {
  if (variant !== 'dot' && count <= 0) return null;
  const cls = [styles.badge, className].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      data-variant={variant}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {variant === 'dot' ? null : formatBadgeCount(count, max)}
    </span>
  );
}
