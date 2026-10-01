import { memo } from 'react';
import { formatDayDivider } from '@/core/domain';
import styles from './Rows.module.css';

export const DayDivider = memo(function DayDivider({ at }: { at: number }) {
  return (
    <div className={styles.day} role="separator" aria-label={formatDayDivider(at)}>
      <span className={styles.dayLabel}>{formatDayDivider(at)}</span>
    </div>
  );
});
