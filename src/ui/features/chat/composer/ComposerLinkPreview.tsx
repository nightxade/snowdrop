import { Link as LinkIcon, X } from 'lucide-react';
import { IconButton } from '@/ui/primitives';
import { previewDomain } from '../lib/linkPreviews';
import type { LinkPreviewView } from './useLinkPreview';
import styles from './ComposerParts.module.css';

/**
 * The composer's compact link-preview card, above the message box: a
 * loading placeholder while `view.loading`, then the fetched preview once
 * it resolves. Hidden entirely once nothing is left to show — see
 * `useLinkPreview` for when that is (no url, dismissed, or nothing found).
 */
export function ComposerLinkPreview({ view }: { view: LinkPreviewView }) {
  if (!view.url) return null;
  return (
    <div className={styles.linkPreview} data-snowdrop="composer-link-preview">
      {view.loading || !view.preview ? (
        <span className={styles.linkPreviewLoading} aria-live="polite">
          <LinkIcon size={14} aria-hidden />
          Fetching a preview…
        </span>
      ) : (
        <>
          {view.preview.image?.previewUrl ? (
            <img
              src={view.preview.image.previewUrl}
              alt=""
              className={styles.linkPreviewThumb}
              draggable={false}
            />
          ) : (
            <LinkIcon size={16} aria-hidden className={styles.linkPreviewIcon} />
          )}
          <span className={styles.linkPreviewText}>
            <span className={styles.linkPreviewDomain}>{previewDomain(view.preview.url)}</span>
            <span className={styles.linkPreviewTitle}>{view.preview.title}</span>
          </span>
        </>
      )}
      <IconButton
        className={styles.remove}
        size="sm"
        label="Remove link preview"
        icon={<X />}
        onClick={view.dismiss}
      />
    </div>
  );
}
