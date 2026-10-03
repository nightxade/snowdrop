import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './HealthDot.module.css';

/** Only shown when the connection isn't healthy (PLAN §4.2); click retries. */
export function HealthDot() {
  const { stores, sync } = useSnowdrop();
  const status = useStore(stores.session, sessionSelectors.status);
  const ready = useStore(stores.session, sessionSelectors.ready);
  if (status === 'online' || (!ready && status === 'offline')) return null;
  const label =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'error'
        ? 'Connection problem — click to retry'
        : 'Offline — click to retry';
  return (
    <div className={styles.wrap}>
      <Tooltip label={label} side="right">
        <button
          type="button"
          className={styles.dot}
          data-status={status}
          aria-label={label}
          disabled={status === 'connecting'}
          onClick={() => {
            void sync.start().catch(() => undefined);
          }}
        />
      </Tooltip>
    </div>
  );
}
