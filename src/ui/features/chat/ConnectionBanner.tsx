import { RotateCw, WifiOff, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import styles from './ConnectionBanner.module.css';

/** Slim banner at the top of the chat column when the connection degrades (PLAN §4.10). */
export function ConnectionBanner() {
  const { stores, sync } = useSnowdrop();
  const status = useStore(stores.session, sessionSelectors.status);
  const ready = useStore(stores.session, sessionSelectors.ready);
  const error = useStore(stores.session, sessionSelectors.error);
  const backend = useStore(stores.session, (s) => s.backendKind);
  const [retrying, setRetrying] = useState(false);

  // Before the first sync, "offline"/"connecting" is just booting; the shell shows skeletons.
  if (status === 'online' || (!ready && status !== 'error')) return null;

  const daemon = backend === 'signal-cli' ? 'the signal-cli daemon' : 'the demo backend';
  const message =
    status === 'connecting'
      ? `Reconnecting to ${daemon}…`
      : status === 'error'
        ? `Can't reach ${daemon}${error ? `: ${error}` : '.'}`
        : `You're offline. Messages you send will go out when ${daemon} is back.`;

  const retry = () => {
    setRetrying(true);
    sync
      .start()
      .catch(() => undefined)
      .finally(() => {
        setRetrying(false);
      });
  };

  return (
    <div
      className={styles.banner}
      data-status={status}
      role="status"
      data-snowdrop="connection-banner"
    >
      {status === 'connecting' ? (
        <LoaderCircle className={styles.spin} size={16} aria-hidden />
      ) : (
        <WifiOff size={16} aria-hidden />
      )}
      <span className={styles.text}>{message}</span>
      {status !== 'connecting' && (
        <button type="button" className={styles.retry} onClick={retry} disabled={retrying}>
          <RotateCw size={14} aria-hidden className={retrying ? styles.spin : undefined} />
          Retry
        </button>
      )}
    </div>
  );
}
