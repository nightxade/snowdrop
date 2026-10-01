import { AlertCircle } from 'lucide-react';
import type { Message } from '@/core/domain';
import { useHearth } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import { EditedTag } from './EditedTag';
import * as act from './actions';
import styles from './MessageMeta.module.css';

/** Below the body: failed-send actions, partial delivery ("(edited)" when there is no text). */
export function MessageNotes({
  message: m,
  nameFor,
}: {
  message: Message;
  nameFor: (id: string) => string;
}) {
  const app = useHearth();
  const failed = m.status === 'failed';
  const failedTo = m.failedRecipients ?? [];
  if ((m.editedAt === undefined || m.body !== '') && !failed && failedTo.length === 0) return null;
  return (
    <div className={styles.notes}>
      {m.editedAt !== undefined && m.body === '' && <EditedTag editedAt={m.editedAt} />}
      {failed && (
        <span className={styles.failed} role="status">
          <AlertCircle size={14} aria-hidden />
          Failed to send
          <span aria-hidden>·</span>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              act.retry(app, m);
            }}
          >
            Retry
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              act.discard(app, m);
            }}
          >
            Delete
          </button>
        </span>
      )}
      {failedTo.length > 0 && (
        <Tooltip
          label={`Couldn't deliver to ${failedTo.map(nameFor).join(', ')}. They may have changed devices or left Signal.`}
        >
          <span className={styles.partial} tabIndex={0}>
            <AlertCircle size={14} aria-hidden />
            Not delivered to {failedTo.length} {failedTo.length === 1 ? 'person' : 'people'}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
