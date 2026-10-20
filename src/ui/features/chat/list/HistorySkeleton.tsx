import { useInView } from '@/ui/hooks';
import { Skeleton } from '@/ui/primitives';
import styles from './ListChrome.module.css';

const WIDTHS = ['62%', '38%', '80%', '54%', '70%', '44%', '66%', '30%'];

/** Placeholder rows while history loads (shimmer stops under reduced motion). */
export function HistorySkeleton({ rows }: { rows: number }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={styles.skeleton}
      aria-hidden
      data-snowdrop="history-skeleton"
      data-shimmer={inView ? undefined : 'off'}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <Skeleton width={40} height={40} radius="full" />
          <div className={styles.skeletonLines}>
            <Skeleton width={i % 3 === 0 ? 140 : 100} height={12} />
            <Skeleton width={WIDTHS[i % WIDTHS.length] ?? '50%'} height={12} />
            {i % 2 === 0 && (
              <Skeleton width={WIDTHS[(i + 3) % WIDTHS.length] ?? '40%'} height={12} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
