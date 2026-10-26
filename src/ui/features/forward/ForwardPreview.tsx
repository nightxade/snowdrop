import { FileText, Film, Image as ImageIcon, LoaderCircle, Mic, Sticker, X } from 'lucide-react';
import { attachmentKind, isVoiceNote } from '@/core/domain';
import { attachmentFailureCopy, formatBytes } from '@/ui/features/chat';
import { Button, IconButton } from '@/ui/primitives';
import { previewStillApplies, type ForwardDraft, type ForwardFileRef } from './model';
import type { ForwardMedia } from './media';
import styles from './forward.module.css';

export interface ForwardPreviewProps {
  drafts: readonly ForwardDraft[];
  media: ForwardMedia;
  nameFor: (id: string) => string;
  /** Show each message's text (the editor shows it itself). */
  showText: boolean;
  /** Take a file out of what is sent (only drafts that can change). */
  onRemoveFile: (draft: ForwardDraft, file: ForwardFileRef) => void;
  /** Drop the link preview. */
  onRemovePreview: (draft: ForwardDraft) => void;
  disabled: boolean;
}

function FileIcon({ file }: { file: ForwardFileRef }) {
  if (file.voiceNote || isVoiceNote(file.attachment)) return <Mic size={16} aria-hidden />;
  const kind = attachmentKind({ contentType: file.contentType });
  if (kind === 'image') return <ImageIcon size={16} aria-hidden />;
  if (kind === 'video') return <Film size={16} aria-hidden />;
  return <FileText size={16} aria-hidden />;
}

/**
 * What is being forwarded: who sent it, its text, each file with the state of
 * its download (a received file is fetched before it can go out), a sticker
 * or the link preview that travels with it.
 */
export function ForwardPreview({
  drafts,
  media,
  nameFor,
  showText,
  onRemoveFile,
  onRemovePreview,
  disabled,
}: ForwardPreviewProps) {
  return (
    <section
      className={styles.preview}
      aria-label={drafts.length === 1 ? 'Message to forward' : 'Messages to forward'}
      data-snowdrop="forward-preview"
    >
      {drafts.map((draft) => (
        <article key={draft.messageId} className={styles.item}>
          <p className={styles.from}>{nameFor(draft.authorId)}</p>
          {draft.sticker && (
            <p className={styles.sticker}>
              <Sticker size={16} aria-hidden />
              <span>Sticker{draft.sticker.emoji ? ` ${draft.sticker.emoji}` : ''}</span>
            </p>
          )}
          {showText && draft.plain !== '' && <p className={styles.text}>{draft.plain}</p>}
          {draft.files.length > 0 && (
            <ul className={styles.files} aria-label="Attachments">
              {draft.files.map((file) => {
                const state = media.stateOf(draft, file);
                const copy = state.status === 'error' ? attachmentFailureCopy(state.kind) : null;
                const detail =
                  state.status === 'loading'
                    ? 'Downloading…'
                    : state.status === 'backfilling'
                      ? 'Getting it from your phone…'
                      : (copy?.detail ?? (file.size !== undefined ? formatBytes(file.size) : ''));
                return (
                  <li key={file.key} className={styles.file} data-state={state.status}>
                    <span className={styles.fileIcon}>
                      <FileIcon file={file} />
                    </span>
                    <span className={styles.fileText}>
                      <span className={styles.fileName}>{file.fileName}</span>
                      <span
                        className={styles.fileDetail}
                        data-error={state.status === 'error' ? '' : undefined}
                        role={state.status === 'error' ? 'alert' : 'status'}
                      >
                        {(state.status === 'loading' || state.status === 'backfilling') && (
                          <LoaderCircle size={12} className={styles.spin} aria-hidden />
                        )}
                        {detail}
                      </span>
                    </span>
                    {copy?.retryable === true && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={`Try ${file.fileName} again`}
                        onClick={() => {
                          media.retry(draft, file);
                        }}
                      >
                        Try again
                      </Button>
                    )}
                    {draft.editable && (
                      <IconButton
                        size="sm"
                        label={
                          state.status === 'error'
                            ? `Leave out ${file.fileName}`
                            : `Remove ${file.fileName}`
                        }
                        icon={<X />}
                        disabled={disabled}
                        onClick={() => {
                          onRemoveFile(draft, file);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {draft.preview && previewStillApplies(draft) && (
            <p className={styles.link}>
              <span className={styles.linkText}>{draft.preview.title ?? draft.preview.url}</span>
              {draft.editable && (
                <IconButton
                  size="sm"
                  label="Remove link preview"
                  icon={<X />}
                  disabled={disabled}
                  onClick={() => {
                    onRemovePreview(draft);
                  }}
                />
              )}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
