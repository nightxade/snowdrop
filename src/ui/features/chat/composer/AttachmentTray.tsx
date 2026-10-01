import { FileText, X } from 'lucide-react';
import { IconButton } from '@/ui/primitives';
import { formatBytes } from '../lib/attachments';
import styles from './ComposerParts.module.css';

export interface PendingAttachment {
  id: string;
  file: File;
  /** Object URL for image previews; revoked when removed or sent. */
  previewUrl?: string;
}

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: readonly PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className={styles.tray} aria-label="Attachments to send" data-shrike="attachment-tray">
      {attachments.map((a) => (
        <li key={a.id} className={styles.tile}>
          <div className={styles.preview}>
            {a.previewUrl ? (
              <img src={a.previewUrl} alt="" className={styles.thumb} draggable={false} />
            ) : (
              <FileText size={32} strokeWidth={1.5} aria-hidden className={styles.fileIcon} />
            )}
          </div>
          <span className={styles.fileName} title={a.file.name}>
            {a.file.name}
          </span>
          <span className={styles.fileSize}>{formatBytes(a.file.size)}</span>
          <IconButton
            className={styles.remove}
            size="sm"
            label={`Remove ${a.file.name}`}
            icon={<X />}
            onClick={() => {
              onRemove(a.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
