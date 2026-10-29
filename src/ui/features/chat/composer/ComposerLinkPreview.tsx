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
  // A fetched preview, or (editing) the one the message already has.
  const card = view.preview
    ? { url: view.preview.url, title: view.preview.title, thumb: view.preview.image?.previewUrl }
    : view.kept
      ? { url: view.kept.url, title: view.kept.title ?? view.kept.url, thumb: view.kept.image?.url }
      : undefined;
  return (
    <div className={styles.linkPreview} data-snowdrop="composer-link-preview">
      {view.loading || !card ? (
        <span className={styles.linkPreviewLoading} aria-live="polite">
          <LinkIcon size={14} aria-hidden />
          Fetching a preview…
        </span>
      ) : (
        <>
          {card.thumb ? (
            <img src={card.thumb} alt="" className={styles.linkPreviewThumb} draggable={false} />
          ) : (
            <LinkIcon size={16} aria-hidden className={styles.linkPreviewIcon} />
          )}
          <span className={styles.linkPreviewText}>
            <span className={styles.linkPreviewDomain}>{previewDomain(card.url)}</span>
            <span className={styles.linkPreviewTitle}>{card.title}</span>
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
