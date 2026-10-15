import { memo } from 'react';
import { formatDayDivider } from '@/core/domain';
import styles from './Rows.module.css';

export const DayDivider = memo(function DayDivider({ at }: { at: number }) {
  return (
    // No separator role: the feed may only own articles. The date stays as text.
    <div className={styles.day} data-snowdrop="day-divider">
      <span className={styles.dayLabel}>{formatDayDivider(at)}</span>
    </div>
  );
});
